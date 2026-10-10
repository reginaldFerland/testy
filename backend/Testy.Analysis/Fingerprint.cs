using System.Buffers;
using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Testy.Analysis;

// Streams a syntax tree into SHA-256 without materializing a normalized copy of it.
// Whitespace and line breaks never contribute; tokens, comments, directives and
// every other piece of trivia do, each framed by a kind and a length so that
// neighbouring pieces cannot run together.
//
// The body fingerprint covers the whole tree. The signature fingerprint covers
// only what another file can depend on without executing a statement here: it
// omits the executable bodies of methods and accessors and the expression bodies
// of properties and indexers, and the bodies of instance constructors and
// operators, replacing each with a marker. Ordinary comments are left out of it too (they
// are in the body fingerprint). Everything else stays: documentation comments (a source
// generator can copy them into code that no trace maps back), constructor
// initializers (`: base(...)`), field and property initializers, static constructors and
// finalizers (they run outside any one test, so no test's coverage vouches for an edit), disabled
// `#if` text and directives. A file Roslyn sees as
// coverage-blind (see SourceAnalysis) uses its body stream as its signature.
// Either way, the directives found in the file are appended to the signature.
static class Fingerprint
{
    // Mixed into both hashes: bump it when what a signature covers changes, so that no
    // fingerprint made by another version can compare equal.
    const string Format = "3";

    public static (string Signature, string Body) Compute(SyntaxNode root, bool blind, IReadOnlyList<string> directives)
    {
        using var body = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        using var signature = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        using (var writer = new Writer(body, signature)) { writer.Write('V', Format); }
        if (blind)
        {
            using var writer = new Writer(body, signature);
            Walk(root, elide: false, writer);
        }
        else
        {
            using (var writer = new Writer(body, null)) { Walk(root, elide: false, writer); }
            using (var writer = new Writer(signature, null)) { Walk(root, elide: true, writer); }
        }
        using (var writer = new Writer(signature, null))
        {
            foreach (var directive in directives) { writer.Write('D', directive); }
        }
        return (Convert.ToHexString(signature.GetHashAndReset()), Convert.ToHexString(body.GetHashAndReset()));
    }

    // Replaced by a marker in the signature: the executable bodies another file can only reach by running them.
    static bool Elided(SyntaxNode node) => node switch
    {
        BlockSyntax => node.Parent is MethodDeclarationSyntax or AccessorDeclarationSyntax or OperatorDeclarationSyntax or ConversionOperatorDeclarationSyntax
            || InstanceConstructor(node.Parent),
        ArrowExpressionClauseSyntax => node.Parent is MethodDeclarationSyntax or AccessorDeclarationSyntax or PropertyDeclarationSyntax or IndexerDeclarationSyntax
            or OperatorDeclarationSyntax or ConversionOperatorDeclarationSyntax || InstanceConstructor(node.Parent),
        _ => false
    };

    static bool InstanceConstructor(SyntaxNode? node) => node is ConstructorDeclarationSyntax constructor && !constructor.Modifiers.Any(SyntaxKind.StaticKeyword);

    static void Walk(SyntaxNode root, bool elide, Writer writer)
    {
        // Flat enumeration: deeply nested expressions cannot overflow the stack.
        foreach (var child in root.DescendantNodesAndTokens(node => !elide || !Elided(node)))
        {
            if (child.IsToken) { Token(child.AsToken(), writer, comments: !elide); }
            else if (elide && Elided(child.AsNode()!)) { writer.Write(child.AsNode() is BlockSyntax ? 'B' : 'E', ""); }
        }
    }

    static void Token(SyntaxToken token, Writer writer, bool comments)
    {
        Trivia(token.LeadingTrivia, writer, comments);
        writer.Write('T', token.Text);
        Trivia(token.TrailingTrivia, writer, comments);
    }

    static void Trivia(SyntaxTriviaList list, Writer writer, bool comments)
    {
        foreach (var trivia in list)
        {
            var kind = trivia.Kind();
            if (kind is SyntaxKind.WhitespaceTrivia or SyntaxKind.EndOfLineTrivia) { continue; }
            if (!comments && kind is SyntaxKind.SingleLineCommentTrivia or SyntaxKind.MultiLineCommentTrivia) { continue; }
            if (trivia.HasStructure)
            {
                // Directives and documentation comments: their tokens, not their layout.
                foreach (var token in trivia.GetStructure()!.DescendantTokens()) { Token(token, writer, comments); }
            }
            else { writer.Write('C', trivia.ToString()); }
        }
    }

    // Batches many small pieces into few calls: each hasher call crosses into the platform crypto library.
    sealed class Writer(IncrementalHash first, IncrementalHash? second) : IDisposable
    {
        private readonly byte[] buffer = ArrayPool<byte>.Shared.Rent(16 * 1024);
        private int length;

        public void Write(char kind, ReadOnlySpan<char> text)
        {
            const int header = 5;
            var needed = header + Encoding.UTF8.GetMaxByteCount(text.Length);
            if (needed > buffer.Length - length)
            {
                Flush();
                if (needed > buffer.Length)
                {
                    var large = ArrayPool<byte>.Shared.Rent(needed);
                    try { Append(large, kind, text); Flush(large.AsSpan(0, length)); length = 0; }
                    finally { ArrayPool<byte>.Shared.Return(large); }
                    return;
                }
            }
            Append(buffer, kind, text);
        }

        private void Append(byte[] target, char kind, ReadOnlySpan<char> text)
        {
            target[length] = (byte)kind;
            // The length in chars frames the text; the bytes that follow are its UTF-8.
            BinaryPrimitives.WriteInt32LittleEndian(target.AsSpan(length + 1), text.Length);
            length += 5 + Encoding.UTF8.GetBytes(text, target.AsSpan(length + 5));
        }

        private void Flush() { Flush(buffer.AsSpan(0, length)); length = 0; }

        private void Flush(ReadOnlySpan<byte> data)
        {
            if (data.IsEmpty) { return; }
            first.AppendData(data);
            second?.AppendData(data);
        }

        public void Dispose()
        {
            Flush();
            ArrayPool<byte>.Shared.Return(buffer);
        }
    }
}
