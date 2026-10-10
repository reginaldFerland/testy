using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Testy.Analysis;

// Source analysis requests, shared by the one-shot and server modes. Every
// request reads its files afresh and keeps no state, so a long-lived process
// cannot serve results for bytes that have since changed.
static class SourceAnalysis
{
    // The extension can keep several servers, each serving requests concurrently with several
    // workers apiece. Without a shared bound they would oversubscribe the machine.
    internal static readonly SemaphoreSlim Cpu = new(Environment.ProcessorCount, Environment.ProcessorCount);

    // Runs a sample that uses every Roslyn API the analysis depends on, so that a Roslyn
    // that cannot be loaded, or that behaves differently from what this analysis was
    // written for, fails the start of the server and not the first real request.
    [MethodImpl(MethodImplOptions.NoInlining)]
    public static async Task WarmAsync()
    {
        const string sample = "global using Hidden = System.Diagnostics.CodeAnalysis.ExcludeFromCodeCoverageAttribute;\n"
            + "using Blind = System.Diagnostics.CodeAnalysis.ExcludeFromCodeCoverageAttribute;\n"
            + "namespace N;\n#if NEVER\nclass Disabled {}\n#endif\n"
            + "[Blind] public partial class C<T> { public int P => 1; public int this[int i] { get { return i; } } public int M(int x) { return x; }\n"
            + "#line 5 \"mapped.cs\"\n public void L() { }\n#line default\n}\n";
        var shape = await AnalyzeAsync(sample);
        if (shape is null || !shape.ExcludedTypes.SequenceEqual(["N:C`1"]) || !shape.PartialTypes.SequenceEqual(["N:C`1"]) || !GlobalAliases(sample).SequenceEqual(["Hidden"]))
        {
            throw new InvalidOperationException("The installed Roslyn did not analyze the self-test source as expected.");
        }
        // The contract that selection relies on: executable edits keep the declaration signature, declaration edits change it.
        var original = await AnalyzeAsync("class D { int M(int x) { return x; } int P => 1; int this[int i] { get { return i; } } }");
        var edited = await AnalyzeAsync("class D { int M(int x) { return x + 1; } int P => 2; int this[int i] { get { return i + 1; } } }");
        var redeclared = await AnalyzeAsync("class D { int M(long x) { return x; } int P => 1; int this[int i] { get { return i; } } }");
        if (original is null || edited is null || redeclared is null || original.Signature == original.Body
            || original.Signature != edited.Signature || original.Body == edited.Body || original.Signature == redeclared.Signature)
        {
            throw new InvalidOperationException("The installed Roslyn did not fingerprint the self-test declarations as expected.");
        }
    }

    internal static async Task<SourceShape?> AnalyzeAsync(string text) => (await AnalyzeBytes(Encoding.UTF8.GetBytes(text), [], CancellationToken.None)).Shape;

    // The Roslyn this process runs on, for diagnostics.
    [MethodImpl(MethodImplOptions.NoInlining)]
    public static string Describe() => $"{typeof(SyntaxNode).Assembly.GetName().Version} from {RoslynLoader.Location}";

    // Relative paths in a request mean what they mean to the caller's working directory.
    // requestBytes are the exact serialized request, bound into provenance responses.
    [MethodImpl(MethodImplOptions.NoInlining)]
    public static async Task<string> HandleAsync(JsonElement request, byte[] requestBytes, string cwd, CancellationToken cancellationToken)
    {
        var provenance = request.TryGetProperty("provenance", out var requestedProvenance) && requestedProvenance.GetBoolean();
        var combined = request.TryGetProperty("allFiles", out var allFiles);
        if (!combined && request.TryGetProperty("aliasSources", out var aliasSources))
        {
            var names = aliasSources.Deserialize<string[]>()!.SelectMany(GlobalAliases).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray();
            return JsonSerializer.Serialize(names, AnalysisJson.Default.StringArray);
        }
        if (request.TryGetProperty("assembly", out var assembly))
        {
            return JsonSerializer.Serialize(SourceLocations.Read(Path.GetFullPath(assembly.GetString()!, cwd), cancellationToken), AnalysisJson.Default.DictionaryStringLocation);
        }
        var files = request.GetProperty("files").Deserialize<string[]>()
            ?? throw new ArgumentException("Expected an array of source paths.");
        var aliases = request.GetProperty("excludedAliases").Deserialize<string[]>() ?? [];
        if (combined)
        {
            var resolved = request.GetProperty("aliasSources").Deserialize<string[]>()!
                .SelectMany(GlobalAliases).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray();
            if (!resolved.ToHashSet(StringComparer.Ordinal).SetEquals(aliases))
            {
                files = allFiles.Deserialize<string[]>() ?? throw new ArgumentException("Expected all analysis source paths.");
            }
            aliases = resolved;
        }
        var concurrency = request.TryGetProperty("concurrency", out var requestedConcurrency)
            ? Math.Clamp(requestedConcurrency.GetInt32(), 1, Environment.ProcessorCount) : 1;
        // Workers own their syntax tree and result slot. Publish only after all work
        // completes, in input order, so concurrency does not change fingerprints or JSON.
        var analyses = new AnalyzedSource[files.Length];
        await Parallel.ForEachAsync(Enumerable.Range(0, files.Length),
            new ParallelOptions { MaxDegreeOfParallelism = concurrency, CancellationToken = cancellationToken }, async (index, token) =>
            {
                analyses[index] = await AnalyzeSource(Path.GetFullPath(files[index], cwd), aliases, token);
            });
        var result = new Dictionary<string, SourceShape?>();
        for (var index = 0; index < files.Length; index++) { result[files[index]] = analyses[index].Shape; }
        if (provenance)
        {
            var sourceHashes = new Dictionary<string, string?>();
            for (var index = 0; index < files.Length; index++) { sourceHashes[files[index]] = analyses[index].SourceHash; }
            return JsonSerializer.Serialize(new SourceAnalysisProvenance(1, Convert.ToHexString(SHA256.HashData(requestBytes)), aliases, result, sourceHashes), AnalysisJson.Default.SourceAnalysisProvenance);
        }
        return combined ? JsonSerializer.Serialize(new CombinedAnalysis(aliases, result), AnalysisJson.Default.CombinedAnalysis) : JsonSerializer.Serialize(result, AnalysisJson.Default.DictionaryStringSourceShape);
    }

    static async Task<AnalyzedSource> AnalyzeSource(string file, string[] aliases, CancellationToken cancellationToken)
    {
        // The fingerprint must describe the bytes Roslyn receives, not a separate
        // read before or after parsing. Retain ReadAllText's BOM/encoding behavior.
        // A file that is missing, locked or unreadable gets the conservative
        // unknown result instead of failing every other file in the batch.
        byte[] bytes;
        try { bytes = await File.ReadAllBytesAsync(file, cancellationToken); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { return new(null, null); }
        // Parsing and hashing are CPU-bound. Every request in this process, however many
        // are running and however many workers each fans out to, shares these slots.
        await Cpu.WaitAsync(cancellationToken);
        try { return await AnalyzeBytes(bytes, aliases, cancellationToken); }
        finally { Cpu.Release(); }
    }

    internal static async Task<AnalyzedSource> AnalyzeBytes(byte[] bytes, string[] aliases, CancellationToken cancellationToken)
    {
        var sourceHash = Convert.ToHexString(SHA256.HashData(bytes));
        var tree = CSharpSyntaxTree.ParseText(Decode(bytes), cancellationToken: cancellationToken);
        if (tree.GetDiagnostics(cancellationToken).Any(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error))
        {
            return new(null, sourceHash);
        }
        var root = await tree.GetRootAsync(cancellationToken);
        // One pass over the nodes; the lists below are filtered once the aliases are known.
        var usings = new List<UsingDirectiveSyntax>(); var allAttributes = new List<AttributeSyntax>(); var types = new List<TypeDeclarationSyntax>();
        foreach (var node in root.DescendantNodes())
        {
            switch (node)
            {
                case UsingDirectiveSyntax directive: usings.Add(directive); break;
                case AttributeSyntax attribute: allAttributes.Add(attribute); break;
                case TypeDeclarationSyntax type: types.Add(type); break;
            }
        }
        // An excluded method can share a file with instrumented code. In that
        // case a hit elsewhere in this file cannot prove its callers are known.
        var localAliases = usings.Where(directive => directive.Alias is not null && IsExcluded(Name(directive.Name)))
            .SelectMany(directive => AliasNames(directive.Alias!.Name.Identifier.ValueText)).ToArray();
        var excludedAliases = aliases.Concat(localAliases).ToHashSet(StringComparer.Ordinal);
        bool Excluded(AttributeSyntax attribute) => IsExcluded(Name(attribute.Name)) || excludedAliases.Contains(Name(attribute.Name));
        var attributes = allAttributes.Where(Excluded).ToArray();
        // Compilation symbols are project-specific. An exclusion in disabled
        // text cannot safely be ruled out by this syntax-only analysis.
        var wholeAssembly = attributes.Any(attribute => (attribute.Parent as AttributeListSyntax)?.Target?.Identifier.ValueText == "assembly");
        // Mapped documents/line numbers cannot reliably be joined to the
        // physical file in a coverage report. Include these bodies too.
        var lineMapped = false;
        // Directives can change compilation or metadata even when they occur
        // inside a method whose executable body is omitted from the signature.
        var directives = new List<string>();
        foreach (var trivia in root.DescendantTrivia(descendIntoTrivia: true))
        {
            if (trivia.IsDirective)
            {
                directives.Add(trivia.ToFullString());
                lineMapped |= trivia.Kind() is SyntaxKind.LineDirectiveTrivia or SyntaxKind.LineSpanDirectiveTrivia;
            }
            else if (!wholeAssembly && trivia.IsKind(SyntaxKind.DisabledTextTrivia))
            {
                var text = trivia.ToFullString();
                wholeAssembly = HasExcludedName(text) || excludedAliases.Any(alias => text.Contains(alias, StringComparison.Ordinal));
            }
        }
        var blind = attributes.Length > 0 || localAliases.Length > 0 || lineMapped;
        var (signature, body) = Fingerprint.Compute(root, blind, directives);
        var partialTypes = types.Where(type => type.Modifiers.Any(SyntaxKind.PartialKeyword)).Select(TypeKey).Distinct().ToArray();
        // Attributes on a partial member's defining declaration also affect its
        // implementation in another file. Track the containing type in that case.
        var excludedTypes = attributes.Select(attribute => attribute.FirstAncestorOrSelf<TypeDeclarationSyntax>())
            .OfType<TypeDeclarationSyntax>().Select(TypeKey).ToHashSet(StringComparer.Ordinal);
        if (wholeAssembly) { excludedTypes.Add("*"); }
        return new(new SourceShape(signature, body, partialTypes, [.. excludedTypes]), sourceHash);
    }

    // Same result as a StreamReader with BOM detection, without the stream and
    // buffering for the common UTF-8 cases. SourceText.From would not do: it only
    // detects a subset of the BOMs, which changes the parsed (and hashed) text.
    static string Decode(byte[] bytes)
    {
        if (bytes.AsSpan().StartsWith(new byte[] { 0xEF, 0xBB, 0xBF })) { return Encoding.UTF8.GetString(bytes, 3, bytes.Length - 3); }
        var other = bytes.AsSpan().StartsWith(new byte[] { 0xFF, 0xFE }) || bytes.AsSpan().StartsWith(new byte[] { 0xFE, 0xFF })
            || bytes.AsSpan().StartsWith(new byte[] { 0, 0, 0xFE, 0xFF });
        if (!other) { return Encoding.UTF8.GetString(bytes); }
        using var stream = new MemoryStream(bytes, writable: false);
        using var reader = new StreamReader(stream, Encoding.UTF8, detectEncodingFromByteOrderMarks: true);
        return reader.ReadToEnd();
    }

    static readonly string[] ExcludingAttributes = ["ExcludeFromCodeCoverage", "DebuggerHidden", "DebuggerNonUserCode", "GeneratedCode", "CompilerGenerated"];

    static bool IsExcluded(string name) => ExcludingAttributes
        .Any(attribute => name.EndsWith(attribute, StringComparison.Ordinal) || name.EndsWith(attribute + "Attribute", StringComparison.Ordinal));

    static string Name(SyntaxNode? node) => node is null ? "" : string.Concat(node.DescendantTokens().Select(token => token.ValueText));

    static IEnumerable<string> AliasNames(string name) => name.EndsWith("Attribute", StringComparison.Ordinal) ? [name, name[..^9]] : [name];

    internal static IEnumerable<string> GlobalAliases(string content)
    {
        var root = CSharpSyntaxTree.ParseText(content).GetRoot();
        // Without each compilation's symbols, include aliases from either branch.
        var roots = new[] { root }.Concat(root.DescendantTrivia(descendIntoTrivia: true)
            .Where(trivia => trivia.IsKind(SyntaxKind.DisabledTextTrivia))
            .Select(trivia => CSharpSyntaxTree.ParseText(trivia.ToFullString()).GetRoot()));
        return roots.SelectMany(node => node.DescendantNodes().OfType<UsingDirectiveSyntax>())
            .Where(directive => directive.GlobalKeyword.IsKind(SyntaxKind.GlobalKeyword) && directive.Alias is not null && IsExcluded(Name(directive.Name)))
            .SelectMany(directive => AliasNames(directive.Alias!.Name.Identifier.ValueText));
    }

    static bool HasExcludedName(string text) => ExcludingAttributes
        .Any(name => text.Contains(name, StringComparison.Ordinal));

    static string TypeKey(TypeDeclarationSyntax type)
    {
        var ns = string.Join(".", type.Ancestors().OfType<BaseNamespaceDeclarationSyntax>().Reverse()
            .Select(declaration => string.Concat(declaration.Name.DescendantTokens().Select(token => token.ValueText))));
        var name = string.Join("+", type.AncestorsAndSelf().OfType<TypeDeclarationSyntax>().Reverse()
            .Select(declaration => declaration.Identifier.ValueText + "`" + (declaration.TypeParameterList?.Parameters.Count ?? 0)));
        return ns + ":" + name;
    }
}

sealed record SourceShape(string Signature, string Body, string[] PartialTypes, string[] ExcludedTypes);
sealed record AnalyzedSource(SourceShape? Shape, string? SourceHash);
