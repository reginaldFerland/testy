using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

try
{
    var files = JsonSerializer.Deserialize<string[]>(await File.ReadAllTextAsync(args.Single()))
        ?? throw new ArgumentException("Expected an array of source paths.");
    var result = new Dictionary<string, string?>();
    foreach (var file in files)
    {
        if (!File.Exists(file)) { result[file] = null; continue; }
        var tree = CSharpSyntaxTree.ParseText(await File.ReadAllTextAsync(file));
        if (tree.GetDiagnostics().Any(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error))
        {
            result[file] = null;
            continue;
        }
        var root = await tree.GetRootAsync();
        // Directives can change compilation or metadata even when they occur
        // inside a method whose executable body is omitted from the signature.
        var directives = string.Join("\n", root.DescendantTrivia(descendIntoTrivia: true)
            .Where(trivia => trivia.IsDirective).Select(trivia => trivia.ToFullString()));
        var declarations = new DeclarationSignature().Visit(root)!.NormalizeWhitespace().ToFullString();
        result[file] = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(declarations + directives)));
    }
    Console.WriteLine(JsonSerializer.Serialize(result));
    return 0;
}
catch (Exception exception)
{
    Console.Error.WriteLine(exception.Message);
    return 1;
}

// Only executable method/accessor bodies can use runtime traces alone. Keep
// initializers, constants, constructors, attributes, signatures, and type shape:
// consumers can depend on these without executing a statement in this file.
sealed class DeclarationSignature : CSharpSyntaxRewriter
{
    private static BlockSyntax? Body(BlockSyntax? body) => body is null ? null : SyntaxFactory.Block();
    private static ArrowExpressionClauseSyntax? Expression(ArrowExpressionClauseSyntax? body) =>
        body is null ? null : SyntaxFactory.ArrowExpressionClause(SyntaxFactory.LiteralExpression(SyntaxKind.DefaultLiteralExpression));

    public override SyntaxNode? VisitMethodDeclaration(MethodDeclarationSyntax node) =>
        node.WithBody(Body(node.Body)).WithExpressionBody(Expression(node.ExpressionBody));

    public override SyntaxNode? VisitAccessorDeclaration(AccessorDeclarationSyntax node) =>
        node.WithBody(Body(node.Body)).WithExpressionBody(Expression(node.ExpressionBody));

    public override SyntaxNode? VisitPropertyDeclaration(PropertyDeclarationSyntax node) =>
        base.VisitPropertyDeclaration(node.WithExpressionBody(Expression(node.ExpressionBody)));

    public override SyntaxNode? VisitIndexerDeclaration(IndexerDeclarationSyntax node) =>
        base.VisitIndexerDeclaration(node.WithExpressionBody(Expression(node.ExpressionBody)));
}
