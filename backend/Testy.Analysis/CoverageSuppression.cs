using System.Text.RegularExpressions;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Testy.Analysis;

// In-code coverage suppression, after NCrunch's `//ncrunch: no coverage`: `// testy: no coverage` before a member or type leaves it
// uninstrumented, and so does every member that starts between `// testy: no coverage start` and `// testy: no coverage end`.
// The result is the collector's function-exclusion patterns, matched against `Namespace.Type<T>.Member(arguments)`, the names it
// gives functions: constructors by their type's name, properties and indexers as get_/set_ accessors, operators as op_ methods,
// and lambdas and local functions as compiler-generated names that contain `<Member>`.
static class CoverageSuppression
{
    const string Marker = "testy: no coverage";

    /// <summary>Whether the text mentions the marker at all; callers skip parsing files that do not.</summary>
    public static bool Mentions(string text) => text.Contains(Marker, StringComparison.OrdinalIgnoreCase);

    /// <summary>The function-exclusion patterns of a parsed file's suppressed members, in source order.</summary>
    public static string[] Patterns(SyntaxNode root)
    {
        var markers = new List<(int Position, string Kind)>();
        foreach (var trivia in root.DescendantTrivia(descendIntoTrivia: true))
        {
            if (!trivia.IsKind(SyntaxKind.SingleLineCommentTrivia)) { continue; }
            var text = trivia.ToString().TrimStart('/').Trim();
            if (!text.StartsWith(Marker, StringComparison.OrdinalIgnoreCase)) { continue; }
            var rest = text[Marker.Length..].Trim().ToLowerInvariant();
            markers.Add((trivia.SpanStart, rest is "start" or "end" ? rest : "next"));
        }
        if (markers.Count == 0) { return []; }
        var regions = new List<(int Start, int End)>();
        int? open = null;
        foreach (var (position, kind) in markers)
        {
            if (kind == "start") { open ??= position; }
            else if (kind == "end" && open is { } start) { regions.Add((start, position)); open = null; }
        }
        // A region without an end runs to the end of the file.
        if (open is { } unclosed) { regions.Add((unclosed, root.FullSpan.End)); }
        var patterns = new List<string>();
        foreach (var member in root.DescendantNodes().OfType<MemberDeclarationSyntax>())
        {
            if (member is BaseNamespaceDeclarationSyntax) { continue; }
            var marked = member.GetLeadingTrivia().Any(trivia => trivia.IsKind(SyntaxKind.SingleLineCommentTrivia)
                && markers.Any(marker => marker.Kind == "next" && marker.Position == trivia.SpanStart));
            var inRegion = regions.Any(region => member.SpanStart > region.Start && member.SpanStart < region.End);
            if (!marked && !inRegion) { continue; }
            // A suppressed type covers its members; listing them again would only repeat its pattern.
            if (member.Ancestors().OfType<MemberDeclarationSyntax>().Any(ancestor => patterns.Contains(Pattern(ancestor) ?? ""))) { continue; }
            if (Pattern(member) is { } pattern && !patterns.Contains(pattern)) { patterns.Add(pattern); }
        }
        return [.. patterns];
    }

    /// <summary>The pattern of one member or type, or null for declarations that compile to no function of their own (fields).</summary>
    static string? Pattern(MemberDeclarationSyntax member)
    {
        if (member is BaseTypeDeclarationSyntax or DelegateDeclarationSyntax)
        {
            return member is BaseTypeDeclarationSyntax type ? $"^{TypePrefix(type)}(<[^.]*>)?\\..*" : null;
        }
        if (member.Parent is not TypeDeclarationSyntax owner) { return null; }
        var names = member switch
        {
            MethodDeclarationSyntax method => [method.Identifier.ValueText],
            ConstructorDeclarationSyntax => [owner.Identifier.ValueText, ".ctor", ".cctor"],
            DestructorDeclarationSyntax => ["Finalize"],
            PropertyDeclarationSyntax property => [$"get_{property.Identifier.ValueText}", $"set_{property.Identifier.ValueText}"],
            IndexerDeclarationSyntax => ["get_Item", "set_Item"],
            EventDeclarationSyntax @event => [$"add_{@event.Identifier.ValueText}", $"remove_{@event.Identifier.ValueText}"],
            OperatorDeclarationSyntax => ["op_[A-Za-z]+"],
            ConversionOperatorDeclarationSyntax => ["op_Implicit", "op_Explicit"],
            _ => Array.Empty<string>()
        };
        if (names.Length == 0) { return null; }
        // Lambdas and local functions compile to functions named after their member, in the type or a nested closure class.
        var lambdas = member is MethodDeclarationSyntax named ? $"|.*<{Regex.Escape(named.Identifier.ValueText)}>" : "";
        var functions = string.Join("|", names.Select(name => name.StartsWith("op_[", StringComparison.Ordinal) ? name : Regex.Escape(name)));
        return $"^{TypePrefix(owner)}(<[^.]*>)?\\.(({functions})\\({lambdas})";
    }

    /// <summary>`Namespace\.Outer\.Inner`, escaped; generic arguments follow the innermost type in the collector's names.</summary>
    static string TypePrefix(BaseTypeDeclarationSyntax type)
    {
        var ns = type.Ancestors().OfType<BaseNamespaceDeclarationSyntax>().Reverse().Select(declaration => declaration.Name.ToString().Replace(" ", ""));
        var types = type.AncestorsAndSelf().OfType<BaseTypeDeclarationSyntax>().Reverse().Select(declaration => declaration.Identifier.ValueText);
        return string.Join("\\.", ns.Concat(types).SelectMany(part => part.Split('.')).Select(Regex.Escape));
    }
}
