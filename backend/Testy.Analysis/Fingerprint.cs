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
//
// Each elided body also gets a fingerprint of its own, with its line span: the
// members. Two versions whose signatures are equal have the same bodies in the same
// order, so a member's fingerprint covers its position and its tokens, and a test
// whose coverage reached only unchanged members did not execute the edit. The text
// around the bodies is fingerprinted too, as the gaps: before the first body, between
// each two, and after the last. Member and gap fingerprints include comments and line
// breaks, so an unchanged one keeps the layout of its lines and a line covered there
// moves to the new version by the offset of its span. A blind file has no members:
// its signature already changes with every edit.
static class Fingerprint
{
    // Mixed into every hash: bump it when what a fingerprint covers changes, so that no
    // fingerprint made by another version can compare equal.
    const string Format = "4";

    public static (string Signature, string Body, MemberBody[] Members, string[] Gaps) Compute(SyntaxNode root, bool blind, IReadOnlyList<string> directives)
    {
        var members = new List<MemberBody>();
        var gaps = new List<string>();
        using var body = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        using var signature = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        using (var writer = new Writer(body, signature)) { writer.Write('V', Format); }
        if (blind)
        {
            using var writer = new Writer(body, signature);
            Walk(root, elide: false, writer, Text.Tokens);
        }
        else
        {
            using (var writer = new Writer(body, null)) { Walk(root, elide: false, writer, Text.Tokens); }
            using (var writer = new Writer(signature, null)) { Walk(root, elide: true, writer, Text.Declarations, node => members.Add(Member(node, members.Count))); }
            Gaps(root, gaps);
        }
        using (var writer = new Writer(signature, null))
        {
            foreach (var directive in directives) { writer.Write('D', directive); }
        }
        return (Convert.ToHexString(signature.GetHashAndReset()), Convert.ToHexString(body.GetHashAndReset()), [.. members], [.. gaps]);
    }

    // The body's 1-based physical lines and the hash of its position, tokens, comments and line breaks.
    static MemberBody Member(SyntaxNode node, int ordinal)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        using (var writer = new Writer(hash, null))
        {
            writer.Write('V', Format);
            writer.Write('O', ordinal.ToString(System.Globalization.CultureInfo.InvariantCulture));
            Walk(node, elide: false, writer, Text.Lines);
        }
        var span = node.GetLocation().GetLineSpan();
        return new(span.StartLinePosition.Line + 1, span.EndLinePosition.Line + 1, Convert.ToHexString(hash.GetHashAndReset()));
    }

    // One fingerprint for the text before, between and after the elided bodies, line breaks included.
    static void Gaps(SyntaxNode root, List<string> gaps)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        using var writer = new Writer(hash, null);
        void Start() { writer.Write('V', Format); writer.Write('O', gaps.Count.ToString(System.Globalization.CultureInfo.InvariantCulture)); }
        void Finish() { writer.Flush(); gaps.Add(Convert.ToHexString(hash.GetHashAndReset())); }
        Start();
        Walk(root, elide: true, writer, Text.Lines, _ => { Finish(); Start(); });
        Finish();
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

    // What a walk writes besides tokens: declarations leave out ordinary comments, lines keep line breaks too.
    enum Text { Declarations, Tokens, Lines }

    static void Walk(SyntaxNode root, bool elide, Writer writer, Text text, Action<SyntaxNode>? elided = null)
    {
        // Flat enumeration: deeply nested expressions cannot overflow the stack.
        foreach (var child in root.DescendantNodesAndTokens(node => !elide || !Elided(node)))
        {
            if (child.IsToken) { Token(child.AsToken(), writer, text); }
            else if (elide && Elided(child.AsNode()!))
            {
                // The marker ends the gap before it (see Gaps).
                writer.Write(child.AsNode() is BlockSyntax ? 'B' : 'E', "");
                elided?.Invoke(child.AsNode()!);
            }
        }
    }

    static void Token(SyntaxToken token, Writer writer, Text text)
    {
        Trivia(token.LeadingTrivia, writer, text);
        writer.Write('T', token.Text);
        Trivia(token.TrailingTrivia, writer, text);
    }

    static void Trivia(SyntaxTriviaList list, Writer writer, Text text)
    {
        foreach (var trivia in list)
        {
            var kind = trivia.Kind();
            if (kind is SyntaxKind.WhitespaceTrivia) { continue; }
            if (kind is SyntaxKind.EndOfLineTrivia) { if (text == Text.Lines) { writer.Write('N', ""); } continue; }
            if (text == Text.Declarations && kind is SyntaxKind.SingleLineCommentTrivia or SyntaxKind.MultiLineCommentTrivia) { continue; }
            if (trivia.HasStructure)
            {
                // Directives and documentation comments: their tokens, not their layout.
                foreach (var token in trivia.GetStructure()!.DescendantTokens()) { Token(token, writer, text); }
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

        public void Flush() { Flush(buffer.AsSpan(0, length)); length = 0; }

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

// An elided body: its first and last 1-based line and its fingerprint (see Fingerprint).
sealed record MemberBody(int Start, int End, string Hash);
