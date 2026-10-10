using System.Text;
using Testy.Analysis;
using Xunit;

namespace Testy.Backend.Tests;

// Selection relies on this contract: editing only executable method and accessor bodies
// keeps the declaration signature (runtime traces suffice), while anything another file
// can depend on without executing a statement here changes it.
public class SourceFingerprintTests
{
    private const string Baseline = """
        using System;
        namespace N;
        public class D
        {
            public const int K = 1;
            public int F = 5;
            public int Q { get; set; } = 7;
            [Obsolete] public void A() { }
            public D() { F = 1; }
            public int M(int x) { return x; }
            public int P => 1;
            public int this[int i] { get { return i; } }
            public int Expr(int x) => x;
            public int Accessors { get => 1; set { F = value; } }
            public int Local(int x) { int Twice(int y) => y * 2; return Twice(x); }
        }
        """;

    private static async Task<SourceShape> Shape(string text) => await SourceAnalysis.AnalyzeAsync(text) ?? throw new InvalidOperationException("The source did not parse.");

    [Theory]
    [InlineData("public int M(int x) { return x; }", "public int M(int x) { return x + 1; }")]
    [InlineData("public int M(int x) { return x; }", "public int M(int x) { var y = x; if (y > 2) { y--; } return y; }")]
    [InlineData("public int P => 1;", "public int P => 2;")]
    [InlineData("public int P => 1;", "public int P => System.Math.Abs(-1) + 4;")]
    [InlineData("get { return i; }", "get { return i * 2; }")]
    [InlineData("public int Expr(int x) => x;", "public int Expr(int x) => x * x;")]
    [InlineData("public int Accessors { get => 1; set { F = value; } }", "public int Accessors { get => 2; set { F = value + 1; } }")]
    [InlineData("int Twice(int y) => y * 2;", "int Twice(int y) => y * 3;")]
    public async Task AnExecutableBodyEditKeepsTheSignatureButChangesTheBody(string before, string after)
    {
        Assert.Contains(before, Baseline, StringComparison.Ordinal);
        var original = await Shape(Baseline);
        var edited = await Shape(Baseline.Replace(before, after, StringComparison.Ordinal));
        Assert.Equal(original.Signature, edited.Signature);
        Assert.NotEqual(original.Body, edited.Body);
    }

    [Theory]
    // Constants and initializers are read by other files without executing this one.
    [InlineData("public const int K = 1;", "public const int K = 2;")]
    [InlineData("public int F = 5;", "public int F = 6;")]
    [InlineData("public int Q { get; set; } = 7;", "public int Q { get; set; } = 8;")]
    // Signatures.
    [InlineData("public int M(int x) { return x; }", "public int M(long x) { return (int)x; }")]
    [InlineData("public int M(int x) { return x; }", "public long M(int x) { return x; }")]
    [InlineData("public int M(int x) { return x; }", "public int M(int y) { return y; }")]
    [InlineData("public int M(int x) { return x; }", "public int M(int x, int z = 0) { return x; }")]
    [InlineData("public int M(int x) { return x; }", "internal int M(int x) { return x; }")]
    [InlineData("public int M(int x) { return x; }", "public int Renamed(int x) { return x; }")]
    [InlineData("public int M(int x) { return x; }", "public int M(int x) { return x; }\n    public void Added() { }")]
    [InlineData("public int Expr(int x) => x;", "public long Expr(int x) => x;")]
    [InlineData("public int P => 1;", "public long P => 1;")]
    [InlineData("public int this[int i]", "public int this[long i]")]
    [InlineData("public int Accessors { get => 1; set { F = value; } }", "public int Accessors { get => 1; }")]
    // Attributes and type shape.
    [InlineData("[Obsolete] public void A() { }", "[Obsolete(\"x\")] public void A() { }")]
    [InlineData("[Obsolete] public void A() { }", "public void A() { }")]
    [InlineData("[Obsolete] public void A() { }", "[Obsolete, System.Diagnostics.Conditional(\"DEBUG\")] public void A() { }")]
    [InlineData("public class D", "public sealed class D")]
    [InlineData("public class D", "public class D : System.IDisposable")]
    [InlineData("namespace N;", "namespace M;")]
    [InlineData("using System;", "using System;\nusing System.IO;")]
    // Constructors run no caller-visible declaration but stay in the signature.
    [InlineData("public D() { F = 1; }", "public D() { F = 2; }")]
    public async Task ADeclarationEditChangesTheSignature(string before, string after)
    {
        Assert.Contains(before, Baseline, StringComparison.Ordinal);
        var original = await Shape(Baseline);
        var edited = await Shape(Baseline.Replace(before, after, StringComparison.Ordinal));
        Assert.NotEqual(original.Signature, edited.Signature);
        Assert.NotEqual(original.Body, edited.Body);
    }

    [Fact]
    public async Task PreprocessorDirectivesChangeTheSignatureEvenInsideABody()
    {
        var original = await Shape(Baseline);
        var edited = await Shape(Baseline.Replace("public int M(int x) { return x; }", "public int M(int x) {\n#if DEBUG\n return x;\n#else\n return x;\n#endif\n }", StringComparison.Ordinal));
        Assert.NotEqual(original.Signature, edited.Signature);
    }

    [Fact]
    public async Task WhitespaceOnlyEditsChangeNothing()
    {
        var original = await Shape(Baseline);
        var edited = await Shape(Baseline.Replace("{", "{  \r\n\r\n", StringComparison.Ordinal).Replace("public ", "public  ", StringComparison.Ordinal));
        Assert.Equal(original, edited, new ShapeComparer());
    }

    [Fact]
    public async Task SignatureDiffersFromBodyWhenThereIsAnExecutableBody()
    {
        var shape = await Shape(Baseline);
        Assert.NotEqual(shape.Signature, shape.Body);
        Assert.Matches("^[0-9A-F]{64}$", shape.Signature);
        Assert.Matches("^[0-9A-F]{64}$", shape.Body);
    }

    [Fact]
    public async Task SyntaxErrorsHaveNoShape()
    {
        Assert.Null(await SourceAnalysis.AnalyzeAsync("class D { int M( { }"));
    }

    [Theory]
    [InlineData("[System.Diagnostics.CodeAnalysis.ExcludeFromCodeCoverage] class D { int M() { return 1; } }", "[System.Diagnostics.CodeAnalysis.ExcludeFromCodeCoverage] class D { int M() { return 2; } }")]
    [InlineData("[ExcludeFromCodeCoverageAttribute] class D { int M() { return 1; } }", "[ExcludeFromCodeCoverageAttribute] class D { int M() { return 2; } }")]
    [InlineData("[GeneratedCode(\"t\", \"1\")] class D { int M() { return 1; } }", "[GeneratedCode(\"t\", \"1\")] class D { int M() { return 2; } }")]
    [InlineData("class D { [DebuggerHidden] int M() { return 1; } }", "class D { [DebuggerHidden] int M() { return 2; } }")]
    [InlineData("using Blind = System.Diagnostics.CodeAnalysis.ExcludeFromCodeCoverageAttribute;\n[Blind] class D { int M() { return 1; } }", "using Blind = System.Diagnostics.CodeAnalysis.ExcludeFromCodeCoverageAttribute;\n[Blind] class D { int M() { return 2; } }")]
    [InlineData("class D { int M() {\n#line 7 \"mapped.cs\"\n return 1; } }", "class D { int M() {\n#line 7 \"mapped.cs\"\n return 2; } }")]
    public async Task CoverageExcludedOrLineMappedCodeTreatsBodiesAsDeclarations(string before, string after)
    {
        Assert.NotEqual((await Shape(before)).Signature, (await Shape(after)).Signature);
    }

    [Fact]
    public async Task RecordsExcludedAndPartialTypesByNamespaceAndArity()
    {
        var shape = await Shape("namespace A.B;\n[System.Diagnostics.CodeAnalysis.ExcludeFromCodeCoverage] public partial class C<T> { public class Nested { [DebuggerHidden] void M() { } } }\npublic partial struct S { }");
        Assert.Equal(["A.B:C`1", "A.B:C`1+Nested`0"], shape.ExcludedTypes.Order(StringComparer.Ordinal));
        Assert.Equal(["A.B:C`1", "A.B:S`0"], shape.PartialTypes.Order(StringComparer.Ordinal));
    }

    [Fact]
    public async Task AnAssemblyLevelOrDisabledExclusionExcludesEverything()
    {
        Assert.Contains("*", (await Shape("[assembly: System.Diagnostics.CodeAnalysis.ExcludeFromCodeCoverage]\nclass D { }")).ExcludedTypes);
        Assert.Contains("*", (await Shape("class D { }\n#if NEVER\n[ExcludeFromCodeCoverage] class E { }\n#endif\n")).ExcludedTypes);
        Assert.DoesNotContain("*", (await Shape("class D { }\n#if NEVER\nclass E { }\n#endif\n")).ExcludedTypes);
    }

    [Fact]
    public async Task AliasesFromOtherFilesMakeAnAttributeExcluding()
    {
        const string source = "[Hidden] class D { int M() { return 1; } }";
        var plain = (await SourceAnalysis.AnalyzeBytes(Encoding.UTF8.GetBytes(source), [], CancellationToken.None)).Shape!;
        var aliased = (await SourceAnalysis.AnalyzeBytes(Encoding.UTF8.GetBytes(source), ["Hidden"], CancellationToken.None)).Shape!;
        Assert.NotEqual(plain.Signature, plain.Body);
        Assert.Equal(aliased.Signature, aliased.Body);
        Assert.Equal([":D`0"], aliased.ExcludedTypes);
    }

    [Theory]
    [InlineData("global using Hidden = System.Diagnostics.CodeAnalysis.ExcludeFromCodeCoverageAttribute;", new[] { "Hidden" })]
    [InlineData("global using Hidden = System.Diagnostics.DebuggerHiddenAttribute;", new[] { "Hidden" })]
    [InlineData("global using HiddenAttribute = System.Diagnostics.CodeAnalysis.ExcludeFromCodeCoverageAttribute;", new[] { "Hidden", "HiddenAttribute" })]
    [InlineData("using Hidden = System.Diagnostics.CodeAnalysis.ExcludeFromCodeCoverageAttribute;", new string[0])]
    [InlineData("global using Other = System.String;", new string[0])]
    [InlineData("global using System.Text;", new string[0])]
    [InlineData("#if NEVER\nglobal using Hidden = System.Diagnostics.CodeAnalysis.ExcludeFromCodeCoverageAttribute;\n#endif", new[] { "Hidden" })]
    public void FindsGlobalExcludingAliases(string content, string[] expected)
    {
        Assert.Equal(expected, SourceAnalysis.GlobalAliases(content, TestContext.Current.CancellationToken).Order(StringComparer.Ordinal));
    }

    [Fact]
    public async Task TheSourceHashDescribesTheBytesAndTheEncodingDoesNotMatter()
    {
        var text = "class D { string S = \"é日本\"; }";
        var plain = await SourceAnalysis.AnalyzeBytes(Encoding.UTF8.GetBytes(text), [], CancellationToken.None);
        var bom = await SourceAnalysis.AnalyzeBytes([.. Encoding.UTF8.GetPreamble(), .. Encoding.UTF8.GetBytes(text)], [], CancellationToken.None);
        var utf16 = await SourceAnalysis.AnalyzeBytes([.. Encoding.Unicode.GetPreamble(), .. Encoding.Unicode.GetBytes(text)], [], CancellationToken.None);
        Assert.Equal(plain.Shape, bom.Shape, new ShapeComparer());
        Assert.Equal(plain.Shape, utf16.Shape, new ShapeComparer());
        Assert.NotEqual(plain.SourceHash, bom.SourceHash);
        Assert.NotEqual(plain.SourceHash, utf16.SourceHash);
        Assert.Matches("^[0-9A-F]{64}$", plain.SourceHash);
    }

    [Fact]
    public async Task ACancelledRequestStopsParsing()
    {
        using var cancellation = new CancellationTokenSource();
        await cancellation.CancelAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => SourceAnalysis.AnalyzeBytes(Encoding.UTF8.GetBytes(Baseline), [], cancellation.Token));
    }

    [Fact]
    public async Task TheServerSelfTestPasses()
    {
        await SourceAnalysis.WarmAsync();
    }

    private sealed class ShapeComparer : IEqualityComparer<SourceShape?>
    {
        public bool Equals(SourceShape? x, SourceShape? y) => x is not null && y is not null && x.Signature == y.Signature && x.Body == y.Body
            && x.PartialTypes.SequenceEqual(y.PartialTypes) && x.ExcludedTypes.SequenceEqual(y.ExcludedTypes);

        public int GetHashCode(SourceShape? obj) => obj!.Signature.GetHashCode(StringComparison.Ordinal);
    }
}
