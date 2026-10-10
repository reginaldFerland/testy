using Testy.Analysis;
using Xunit;

namespace Testy.Backend.Tests;

// The fingerprints stream tokens and non-layout trivia into a hash instead of normalizing a copy
// of the tree. These pin what that must keep equal to the normalizing implementation it replaced.
public class StreamingFingerprintTests
{
    private const string Baseline = "using System;\n/// <summary>Doc</summary>\npublic class D\n{\n    public int M(int x) { return x; }\n    public int P => 1;\n#region R\n    public int F = 5;\n#endregion\n}\n// end\n";

    private static async Task<SourceShape> Shape(string text) => await SourceAnalysis.AnalyzeAsync(text) ?? throw new InvalidOperationException("The source did not parse.");

    [Theory]
    [InlineData("return x;", "return x; /* why */")]
    [InlineData("return x;", "// why\n return x;")]
    public async Task ACommentInABodyChangesTheBodyButNotTheSignature(string before, string after)
    {
        var original = await Shape(Baseline);
        var edited = await Shape(Baseline.Replace(before, after, StringComparison.Ordinal));
        Assert.Equal(original.Signature, edited.Signature);
        Assert.NotEqual(original.Body, edited.Body);
    }

    [Theory]
    [InlineData("public int F = 5;", "/* why */ public int F = 5;")]
    [InlineData("// end", "// the end")]
    public async Task ACommentOutsideBodiesChangesTheBodyButNotTheSignature(string before, string after)
    {
        var original = await Shape(Baseline);
        var edited = await Shape(Baseline.Replace(before, after, StringComparison.Ordinal));
        Assert.Equal(original.Signature, edited.Signature);
        Assert.NotEqual(original.Body, edited.Body);
    }

    [Fact]
    public async Task ADocumentationCommentChangesBothFingerprints()
    {
        var original = await Shape(Baseline);
        var edited = await Shape(Baseline.Replace("<summary>Doc</summary>", "<summary>Docs</summary>", StringComparison.Ordinal));
        Assert.NotEqual(original.Signature, edited.Signature);
        Assert.NotEqual(original.Body, edited.Body);
    }

    [Theory]
    [InlineData("#region R", "#region S")]
    public async Task ADirectiveOutsideBodiesChangesBoth(string before, string after)
    {
        var original = await Shape(Baseline);
        var edited = await Shape(Baseline.Replace(before, after, StringComparison.Ordinal));
        Assert.NotEqual(original.Signature, edited.Signature);
        Assert.NotEqual(original.Body, edited.Body);
    }

    [Fact]
    public async Task LayoutInsideADirectiveChangesNothingInTheBody()
    {
        var original = await Shape(Baseline);
        var edited = await Shape(Baseline.Replace("#region R", "#region   R", StringComparison.Ordinal));
        Assert.Equal(original.Body, edited.Body);
    }

    [Fact]
    public async Task AdjacentTokensDoNotRunTogether()
    {
        Assert.NotEqual((await Shape("class D { int M() { return a + + b; } }")).Body, (await Shape("class D { int M() { return a + b; } }")).Body);
        Assert.NotEqual((await Shape("class D { int M() { return a+(+b); } }")).Body, (await Shape("class D { int M() { return a ++ ; } }")).Body);
        Assert.NotEqual((await Shape("class D { int M() { var a = \"x\"; } }")).Body, (await Shape("class D { int M() { var a = \"x \"; } }")).Body);
    }

    [Fact]
    public async Task ADeeplyNestedExpressionIsFingerprinted()
    {
        var chain = string.Join(" + ", Enumerable.Repeat("1", 20_000));
        Assert.NotNull(await SourceAnalysis.AnalyzeAsync($"class D {{ int F = {chain}; }}"));
    }
}
