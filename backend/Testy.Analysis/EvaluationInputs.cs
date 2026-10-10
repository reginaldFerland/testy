using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Xml.Linq;
using Microsoft.Build.Evaluation;
using Microsoft.Build.FileSystem;
using Microsoft.Build.Construction;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Text.RegularExpressions;

namespace Testy.Analysis;

// MSBuild's evaluation filesystem observes absent imports and glob searches as
// well as existing files. Watcher events alone cannot validate a saved graph.
internal sealed partial class EvaluationInputs : MSBuildFileSystemBase
{
    internal sealed class Shared
    {
        // Only digests are retained: resolver closures and imports can span
        // thousands of files. An entry is valid for one (length, write time).
        private readonly ConcurrentDictionary<(string path, long length, long ticks), Lazy<string>> hashes = new();
        private readonly ConcurrentDictionary<ProjectRootElement, Lazy<(XDocument xml, string hash, bool valid)>> parsed = new();
        internal readonly string Sdk = Path.GetDirectoryName(typeof(Project).Assembly.Location)!;
        internal readonly string[] ResolverFiles;
        internal readonly Query[] ResolverQueries;
        internal readonly bool ReusableResolvers;
        // Why resolver state cannot be fingerprinted; null when it can.
        internal readonly string? Unsupported;
        private readonly DigestStore? store;
        public Shared() : this(null) { }
        // cacheDirectory persists file digests across evaluations, each a fresh process.
        public Shared(string? cacheDirectory)
        {
            try
            {
                if (!string.IsNullOrEmpty(cacheDirectory)) { store = DigestStore.Open(cacheDirectory, Sdk); }
                // Capture before any graph project is evaluated. The same original
                // resolver bytes/inventory are validated again by every cache hit.
                var dotnetRoot = Path.GetDirectoryName(Path.GetDirectoryName(Sdk))!;
                var resolverDirectory = Path.Combine(Sdk, "SdkResolvers");
                var captured = new HashSet<string>(); var queries = new List<Query>(); string? unsupported = null;
                foreach (var folder in new[] { Path.Combine(dotnetRoot, "sdk-manifests"), Path.Combine(dotnetRoot, "metadata", "workloads"), resolverDirectory })
                {
                    var exists = Directory.Exists(folder); queries.Add(new("directory", folder, null, false, [exists ? "true" : "false"]));
                    if (!exists) { continue; }
                    var inventory = Directory.GetFiles(folder, "*", SearchOption.AllDirectories).Order(StringComparer.Ordinal).ToArray();
                    queries.Add(new("files", folder, "*", true, inventory)); captured.UnionWith(inventory);
                }
                var sdkFiles = Directory.GetFiles(Sdk).Order(StringComparer.Ordinal).ToArray();
                queries.Add(new("files", Sdk, "*", false, sdkFiles));
                queries.Add(new("directories", Path.GetDirectoryName(Sdk)!, "*", false, Directory.GetDirectories(Path.GetDirectoryName(Sdk)!).Order(StringComparer.Ordinal).ToArray()));
                if (Directory.Exists(resolverDirectory) && Directory.GetDirectories(resolverDirectory).FirstOrDefault(folder => Path.GetFileName(folder)
                    is not ("Microsoft.Build.NuGetSdkResolver" or "Microsoft.NET.Sdk.WorkloadMSBuildSdkResolver")) is { } unknown) { unsupported ??= $"Unrecognized SDK resolver: {unknown}"; }
                var pending = new Stack<string>();
                foreach (var descriptor in captured.Where(file => Within(file, resolverDirectory) && Path.GetExtension(file).Equals(".xml", StringComparison.OrdinalIgnoreCase)).ToArray())
                {
                    var resolverPath = XDocument.Load(descriptor).Root?.Element("Path")?.Value;
                    if (string.IsNullOrWhiteSpace(resolverPath)) { unsupported ??= $"SDK resolver manifest has no Path: {descriptor}"; continue; }
                    var assembly = Path.GetFullPath(resolverPath.Replace('\\', Path.DirectorySeparatorChar), Path.GetDirectoryName(descriptor)!);
                    if (!Within(assembly, Sdk)) { unsupported ??= $"SDK resolver outside the SDK: {assembly}"; continue; }
                    pending.Push(assembly);
                }
                var assemblies = new HashSet<string>();
                while (pending.TryPop(out var assembly))
                {
                    if (!assemblies.Add(assembly)) { continue; }
                    captured.Add(assembly);
                    using var stream = System.IO.File.OpenRead(assembly); using var image = new PEReader(stream);
                    if (!image.HasMetadata) { unsupported ??= $"SDK resolver has no metadata: {assembly}"; continue; }
                    var metadata = image.GetMetadataReader();
                    foreach (var reference in metadata.AssemblyReferences)
                    {
                        var name = metadata.GetString(metadata.GetAssemblyReference(reference).Name) + ".dll";
                        var adjacent = Path.Combine(Path.GetDirectoryName(assembly)!, name); var sdkFile = Path.Combine(Sdk, name);
                        if (System.IO.File.Exists(adjacent)) { pending.Push(adjacent); }
                        else if (System.IO.File.Exists(sdkFile)) { pending.Push(sdkFile); }
                    }
                    var deps = Path.ChangeExtension(assembly, ".deps.json");
                    if (System.IO.File.Exists(deps)) { captured.Add(deps); }
                }
                captured.Add(Path.Combine(Sdk, "Microsoft.Build.dll")); captured.Add(Path.Combine(Sdk, "MSBuild.dll"));
                captured.Add(Path.Combine(dotnetRoot, OperatingSystem.IsWindows() ? "dotnet.exe" : "dotnet"));
                foreach (var file in captured) { _ = Hash(file); }
                store?.Save();
                ResolverFiles = captured.ToArray(); ResolverQueries = queries.ToArray(); Unsupported = unsupported; ReusableResolvers = unsupported is null;
            }
            catch (Exception exception)
            {
                ResolverFiles = []; ResolverQueries = []; ReusableResolvers = false;
                Unsupported = $"{exception.GetType().Name}: {exception.Message}";
            }
        }
        internal string Hash(string file)
        {
            var info = new FileInfo(file);
            return hashes.GetOrAdd((file, info.Length, info.LastWriteTimeUtc.Ticks), key => new(() =>
            {
                if (store?.TryGet(key.path, key.length, key.ticks) is { } known) { return known; }
                using var stream = new FileStream(key.path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 1, FileOptions.SequentialScan);
                var hash = Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
                store?.Add(key.path, key.length, key.ticks, hash);
                return hash;
                // PublicationOnly does not cache a failure: a file locked for a moment is read again by the next caller.
            }, LazyThreadSafetyMode.PublicationOnly)).Value;
        }
        internal (XDocument xml, string hash, bool valid) Parsed(ProjectRootElement root) => parsed.GetOrAdd(root, project => new(() =>
        {
            // Hash the same bytes that are compared; they are not retained.
            var saved = System.IO.File.ReadAllBytes(project.FullPath);
            using var diskStream = new MemoryStream(saved);
            using var diskReader = new System.Xml.XmlTextReader(diskStream) { DtdProcessing = System.Xml.DtdProcessing.Prohibit, Normalization = false };
            var disk = XDocument.Parse(ProjectRootElement.Create(diskReader).RawXml); var xml = XDocument.Parse(project.RawXml);
            static void Normalize(XDocument document)
            {
                document.DescendantNodes().OfType<XComment>().Remove();
                document.DescendantNodes().OfType<XText>().Where(text => text.Parent?.HasElements == true && string.IsNullOrWhiteSpace(text.Value)).Remove();
            }
            Normalize(disk); Normalize(xml);
            return (xml, EvaluationInputs.Hash(saved), XNode.DeepEquals(xml.Root, disk.Root));
        }, LazyThreadSafetyMode.PublicationOnly)).Value;
    }
    // Serialized by GraphJson (camelCase), which the TypeScript side reads.
    internal sealed record Query(string Kind, string Path, string? Pattern, bool Recursive, string[] Values);
    internal sealed record Snapshot(bool Reusable, string[] Files, IReadOnlyDictionary<string, string> Hashes, Query[] Queries, string[] ExcludedDirectories, string SdkDirectory, string? Reason);
    private readonly ConcurrentDictionary<string, Query> queries = new();
    private readonly ConcurrentDictionary<string, string> reads = new();
    private readonly Shared shared;
    internal EvaluationInputs(Shared shared) { this.shared = shared; }
    private static string Hash(ReadOnlySpan<byte> bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
    private void Read(string path, ReadOnlySpan<byte> bytes)
    {
        var hash = Hash(bytes);
        reads.AddOrUpdate(Path.GetFullPath(path), hash, (_, before) => before == hash ? before : "changed");
    }
    private void Add(string kind, string file, string[] values, string? pattern = null, bool recursive = false)
    {
        file = Path.GetFullPath(file);
        var key = $"{kind}\0{file}\0{pattern}\0{recursive}";
        var query = new Query(kind, file, pattern, recursive, values);
        queries.AddOrUpdate(key, query, (_, before) => before.Values.SequenceEqual(values) ? before : query with { Kind = "changed" });
    }
    private bool Exists(string kind, string file, Func<bool> read)
    {
        var value = read(); Add(kind, file, [value ? "true" : "false"]); return value;
    }
    public override bool FileExists(string path) => Exists("file", path, () => base.FileExists(path));
    public override bool DirectoryExists(string path) => Exists("directory", path, () => base.DirectoryExists(path));
    public override bool FileOrDirectoryExists(string path) => Exists("exists", path, () => base.FileOrDirectoryExists(path));
    private string[] Enumerate(string kind, string path, string pattern, SearchOption option, Func<IEnumerable<string>> read)
    {
        var values = read().ToArray();
        Add(kind, path, values.Select(Path.GetFullPath).Order(StringComparer.Ordinal).ToArray(), pattern, option == SearchOption.AllDirectories);
        return values;
    }
    public override IEnumerable<string> EnumerateFiles(string path, string searchPattern = "*", SearchOption searchOption = SearchOption.TopDirectoryOnly)
        => Enumerate("files", path, searchPattern, searchOption, () => base.EnumerateFiles(path, searchPattern, searchOption));
    public override IEnumerable<string> EnumerateDirectories(string path, string searchPattern = "*", SearchOption searchOption = SearchOption.TopDirectoryOnly)
        => Enumerate("directories", path, searchPattern, searchOption, () => base.EnumerateDirectories(path, searchPattern, searchOption));
    public override IEnumerable<string> EnumerateFileSystemEntries(string path, string searchPattern = "*", SearchOption searchOption = SearchOption.TopDirectoryOnly)
        => Enumerate("entries", path, searchPattern, searchOption, () => base.EnumerateFileSystemEntries(path, searchPattern, searchOption));
    public override Stream GetFileStream(string path, FileMode mode, FileAccess access, FileShare share)
    {
        if (mode != FileMode.Open || access != FileAccess.Read) { Add("changed", path, []); return base.GetFileStream(path, mode, access, share); }
        // One copy: the same bytes are hashed and served, so what MSBuild parses is what was recorded.
        using var stream = base.GetFileStream(path, mode, access, share);
        var copy = new MemoryStream(stream.CanSeek ? (int)Math.Min(stream.Length, int.MaxValue) : 0);
        stream.CopyTo(copy);
        copy.TryGetBuffer(out var buffer);
        Read(path, buffer);
        return new MemoryStream(buffer.Array!, buffer.Offset, buffer.Count, writable: false);
    }
    public override TextReader ReadFile(string path) => new StreamReader(GetFileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read));
    public override byte[] ReadFileAllBytes(string path) { var bytes = base.ReadFileAllBytes(path); Read(path, bytes); return bytes; }
    public override string ReadFileAllText(string path) { using var reader = ReadFile(path); return reader.ReadToEnd(); }
    public override DateTime GetLastWriteTimeUtc(string path)
    {
        var value = base.GetLastWriteTimeUtc(path);
        Add("mtime", path, [value.Ticks.ToString(System.Globalization.CultureInfo.InvariantCulture)]); return value;
    }
    public override FileAttributes GetAttributes(string path)
    {
        var value = base.GetAttributes(path);
        // Attribute-dependent evaluation is uncommon; preserve correctness by
        // declining reuse instead of translating platform-specific attributes.
        Add("attributes", path, []); return value;
    }

    internal Snapshot Complete(Project project)
    {
        if (!shared.ReusableResolvers) { return new(false, [], new Dictionary<string, string>(), [], [], "", $"Unsupported SDK resolver state: {shared.Unsupported}"); }
        var imports = project.Imports.Select(import => import.ImportedProject.FullPath).Append(project.FullPath).Distinct().ToArray();
        var sdk = project.GetPropertyValue("MSBuildToolsPath");
        var dotnetRoot = Path.GetDirectoryName(Path.GetDirectoryName(sdk))!;
        var manifests = Path.Combine(dotnetRoot, "sdk-manifests");
        var directory = Path.GetDirectoryName(project.FullPath)!;
        var outputs = OutputProperties
            .Select(project.GetPropertyValue).Where(value => !string.IsNullOrWhiteSpace(value)).Select(value => Path.GetFullPath(value.Replace('\\', Path.DirectorySeparatorChar), directory))
            .Append(Path.Combine(directory, "bin")).Append(Path.Combine(directory, "obj")).Distinct().ToArray();
        // Only SDK default globs are allowed to ignore output-directory names.
        // Custom evaluation touching them or running arbitrary property functions
        // is reevaluated: such functions can read files outside MSBuild's facade.
        string? reason = null;
        var standardOutputs = new[] { Path.Combine(directory, "bin"), Path.Combine(directory, "obj") };
        var reusable = shared.ReusableResolvers && string.Equals(sdk, shared.Sdk, PathComparison)
            && outputs.All(output => standardOutputs.Any(standard => Within(output, standard)));
        // The collection may reuse a parsed import without calling our facade.
        // Compare its evaluated XML with the bytes being fingerprinted so a file
        // changed during evaluation cannot bless an older graph with a new hash.
        foreach (var xml in project.Imports.Select(import => import.ImportedProject).Append(project.Xml).Distinct())
        {
            var parsed = shared.Parsed(xml);
            if (!parsed.valid) { reusable = false; reason ??= $"Parsed XML differs: {xml.FullPath}"; }
            if (!Within(xml.FullPath, sdk) && !Within(xml.FullPath, manifests) && !SafeCustomEvaluation(parsed.xml, outputs)) { reusable = false; reason ??= xml.FullPath; }
            reads.TryAdd(Path.GetFullPath(xml.FullPath), parsed.hash);
            foreach (var import in parsed.xml.Descendants().Where(element => element.Name.LocalName == "Import"))
            {
                var expression = import.Attribute("Project")?.Value ?? "";
                if (!expression.Contains('*')) { continue; }
                var expanded = project.ExpandString(ExpandThisFile(expression, xml.FullPath));
                if (expanded.Contains(';') || expanded.Contains('%') || expanded.Contains('?') || expanded.Contains("$(", StringComparison.Ordinal)) { reusable = false; continue; }
                var glob = Path.GetFullPath(expanded.Replace('\\', Path.DirectorySeparatorChar), directory);
                if (!standardOutputs.Any(output => Within(glob, output))) { continue; }
                var folder = Path.GetDirectoryName(glob)!; var pattern = Path.GetFileName(glob);
                if (folder.Contains('*')) { reusable = false; continue; }
                var matches = Directory.Exists(folder) ? Directory.GetFiles(folder, pattern) : [];
                // A matching file may have appeared after MSBuild evaluated the
                // import. Its current inventory cannot validate an older graph.
                // Conditional imports that were not loaded also take a safe miss.
                if (matches.Any(match => !imports.Any(imported => string.Equals(Path.GetFullPath(imported), Path.GetFullPath(match), PathComparison)))) { reusable = false; }
                Add("imports", folder, matches.Select(Path.GetFullPath).Order(StringComparer.Ordinal).ToArray(), pattern);
            }
        }
        foreach (var file in shared.ResolverFiles) { reads.TryAdd(file, shared.Hash(file)); }
        var recorded = queries.Values.Where(query => query.Kind is not ("files" or "directories" or "entries" or "directory") || !outputs.Any(output => Within(query.Path, output))).Select(query => query.Kind is "files" or "directories" or "entries"
            ? query with { Values = query.Values.Where(file => !outputs.Any(output => Within(file, output))).ToArray() } : query).ToArray();
        reusable &= recorded.All(query => query.Kind is not ("attributes" or "changed") && (query.Pattern is null || query.Kind == "imports" || query.Pattern is "*" || ExtensionPattern().IsMatch(query.Pattern)));
        reusable &= reads.Values.All(hash => hash != "changed");
        // Sorted so equal evaluations serialize identically regardless of read order.
        return new Snapshot(reusable, imports.Concat(reads.Keys).Distinct().Order(StringComparer.Ordinal).ToArray(),
            reads.OrderBy(pair => pair.Key, StringComparer.Ordinal).ToDictionary(pair => pair.Key, pair => pair.Value),
            recorded.Concat(shared.ResolverQueries).OrderBy(query => query.Kind, StringComparer.Ordinal).ThenBy(query => query.Path, StringComparer.Ordinal)
                .ThenBy(query => query.Pattern, StringComparer.Ordinal).ThenBy(query => query.Recursive).ToArray(), outputs, sdk, reason);
    }

    [GeneratedRegex(@"^\*\.[A-Za-z0-9]+$")]
    internal static partial Regex ExtensionPattern();
    [GeneratedRegex(@"^MSTest\.Sdk/\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$")]
    internal static partial Regex MSTestSdkName();
    [GeneratedRegex(@"\$\(\[(?:System\.IO\.Path\]::(?:Combine|ChangeExtension|GetDirectoryName|GetFileName|GetFileNameWithoutExtension|GetFullPath|IsPathRooted)|MSBuild\]::(?:NormalizePath|NormalizeDirectory|ValueOrDefault|EnsureTrailingSlash|GetTargetFrameworkIdentifier|GetTargetFrameworkVersion|VersionGreaterThan|VersionGreaterThanOrEquals|VersionLessThan|VersionLessThanOrEquals|VersionEquals)|System\.Version\]::Parse|System\.Text\.RegularExpressions\.Regex\]::(?:Replace|IsMatch))\s*\(")]
    internal static partial Regex SafePropertyFunction();
    [GeneratedRegex(@"\$\((?:BaseOutputPath|OutputPath|BaseIntermediateOutputPath|IntermediateOutputPath|TargetDir)\)", RegexOptions.IgnoreCase)]
    internal static partial Regex OutputProperty();
    [GeneratedRegex(@"(^|[/\\])(?:bin|obj)([/\\]|$)", RegexOptions.IgnoreCase)]
    internal static partial Regex OutputName();
    // Exact reserved-property tokens only; MSBuild resolves these against the
    // file containing the expression, not against the root project.
    [GeneratedRegex(@"\$\(MSBuildThisFile(?<name>DirectoryNoRoot|Directory|FullPath|Name|Extension)?\)", RegexOptions.IgnoreCase)]
    internal static partial Regex ThisFileProperty();

    // MSBuildThisFile* in an import expression names the file containing that expression.
    internal static string ExpandThisFile(string expression, string file) => ThisFileProperty().Replace(expression, match => ThisFile(match.Groups["name"].Value, file));

    private static string ThisFile(string name, string file)
    {
        var directory = Path.GetDirectoryName(file) ?? "";
        return name.ToLowerInvariant() switch
        {
            "directory" => directory + Path.DirectorySeparatorChar,
            "directorynoroot" => directory[(Path.GetPathRoot(directory)?.Length ?? 0)..] + Path.DirectorySeparatorChar,
            "fullpath" => file,
            "name" => Path.GetFileNameWithoutExtension(file),
            "extension" => Path.GetExtension(file),
            _ => Path.GetFileName(file)
        };
    }

    // Properties naming the directories a build writes to, also reported by the graph task.
    internal static readonly string[] OutputProperties = ["TargetDir", "OutputPath", "IntermediateOutputPath", "BaseIntermediateOutputPath", "MSBuildProjectExtensionsPath"];

    private static readonly StringComparison PathComparison = OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
    private static bool Within(string file, string directory) => !string.IsNullOrWhiteSpace(directory)
        && (file.Equals(directory.TrimEnd(Path.DirectorySeparatorChar), PathComparison)
            || file.StartsWith(directory.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, PathComparison));

    internal static bool SafeCustomEvaluation(XDocument document, string[] outputs)
    {
        var elements = document.Descendants().Where(element => !element.AncestorsAndSelf().Any(parent => parent.Name.LocalName is "Target" or "UsingTask"));
        foreach (var element in elements)
        {
            foreach (var sdk in element.Attributes().Where(attribute => attribute.Name.LocalName == "Sdk" && element.Name.LocalName is "Project" or "Import").Select(attribute => attribute.Value)
                .Concat(element.Name.LocalName == "Sdk" ? new[] { element.Attribute("Name")?.Value ?? "" } : []))
            {
                if (sdk.Split(';').Any(name => name is not ("Microsoft.NET.Sdk" or "Microsoft.NET.Sdk.Web" or "Microsoft.NET.Sdk.Razor" or "Microsoft.NET.Sdk.Worker" or "Microsoft.NET.Sdk.WindowsDesktop" or "MSTest.Sdk")
                    && !MSTestSdkName().IsMatch(name))) { return false; }
            }
            var values = element.Attributes().Select(attribute => attribute.Value).Concat(element.HasElements ? [] : new[] { element.Value });
            foreach (var value in values)
            {
                var functions = SafePropertyFunction().Replace(value, "(");
                if (functions.Contains("$([", StringComparison.Ordinal)
                    || value.Contains("DefaultItemExcludes", StringComparison.OrdinalIgnoreCase)
                    || value.Contains("EnableDefault", StringComparison.OrdinalIgnoreCase)) { return false; }
                // Pure property assignments may compute build-only output names.
                // Filesystem expressions using arbitrary properties cannot prove
                // they avoid generated directories throughout evaluation.
                if (element.Parent?.Name.LocalName != "PropertyGroup" || element.Attributes().Any(attribute => attribute.Value == value))
                {
                    if (OutputProperty().IsMatch(value) || OutputName().IsMatch(value)
                        || outputs.Any(output => value.Contains(output, StringComparison.OrdinalIgnoreCase))) { return false; }
                    if (value.Contains("$(", StringComparison.Ordinal) && (value.Contains('*') || value.Contains('?'))) { return false; }
                }
            }
            if (element.Name.LocalName is "DefaultItemExcludes" or "DefaultExcludesInProjectFolder" or "EnableDefaultItems" or "EnableDefaultCompileItems"
                or "BaseOutputPath" or "OutputPath" or "BaseIntermediateOutputPath" or "IntermediateOutputPath" or "MSBuildProjectExtensionsPath" or "OutDir" or "TargetDir" or "ArtifactsPath" or "UseArtifactsOutput" or "PublishDir") { return false; }
        }
        return true;
    }
}
