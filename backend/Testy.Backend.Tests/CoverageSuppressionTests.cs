using System.Text.RegularExpressions;
using Microsoft.CodeAnalysis.CSharp;
using Testy.Analysis;
using Xunit;

namespace Testy.Backend.Tests;

// The patterns must match the names the collector gives functions (Namespace.Type<T>.Member(arguments), see CoverageSuppression),
// and nothing that was not suppressed.
public class CoverageSuppressionTests
{
    private const string Source = """
        namespace App.Inner;
        public class Box<T>
        {
            // testy: no coverage
            public T Get() { System.Func<int, int> f = x => x; return default!; }
            public int Kept() { return 1; }
            // testy: no coverage
            public Box() { }
            // testy: no coverage start
            public int this[int i] { get { return i; } }
            public static Box<T> operator +(Box<T> a, Box<T> b) => a;
            // testy: no coverage end
            public int Name { get { return 2; } }
            // testy: no coverage
            public class Nested { public int Twice(int x) => x * 2; }
        }
        """;

    private static string[] Patterns(string source) => CoverageSuppression.Patterns(CSharpSyntaxTree.ParseText(source).GetRoot());

    private static bool Excluded(string[] patterns, string function) => patterns.Any(pattern => Regex.IsMatch(function, pattern));

    [Fact]
    public void MarkedMembersRegionsAndTypesMatchTheCollectorsFunctionNames()
    {
        var patterns = Patterns(Source);
        foreach (var function in new[] { "App.Inner.Box<T>.Get()", "App.Inner.Box<T>.<Get>b__0_0(int)", "App.Inner.Box<T>.<>c.<Get>b__0_0(int)",
            "App.Inner.Box<T>.Box()", "App.Inner.Box<T>.get_Item(int)", "App.Inner.Box<T>.op_Addition(App.Inner.Box<T>, App.Inner.Box<T>)",
            "App.Inner.Box.Nested<T>.Twice(int)" })
        {
            Assert.True(Excluded(patterns, function), function);
        }
        foreach (var function in new[] { "App.Inner.Box<T>.Kept()", "App.Inner.Box<T>.get_Name()", "App.Inner.Boxes.Get()", "App.Inner.Box<T>.GetAll()" })
        {
            Assert.False(Excluded(patterns, function), function);
        }
    }

    [Fact]
    public void FilesWithoutTheMarkerHaveNoPatternsAndAnOpenRegionRunsToTheEnd()
    {
        Assert.Empty(Patterns("namespace N; public class C { public void M() { } }"));
        Assert.False(CoverageSuppression.Mentions("// no coverage here"));
        var patterns = Patterns("namespace N; public class C {\n// testy: no coverage start\n public void M() { }\n public void L() { }\n}");
        Assert.True(Excluded(patterns, "N.C.M()") && Excluded(patterns, "N.C.L()"));
    }

    [Fact]
    public async Task AFileWithTheMarkerIsAnalyzedConservatively()
    {
        static async Task<string> Signature(string source) => (await SourceAnalysis.AnalyzeBytes(System.Text.Encoding.UTF8.GetBytes(source), [], CancellationToken.None)).Shape!.Signature;
        // A body edit keeps the signature of an ordinary file, but changes it in a file with suppressed code: edits there select conservatively.
        Assert.Equal(await Signature("namespace N; public class C { public int M() { return 1; } }"), await Signature("namespace N; public class C { public int M() { return 2; } }"));
        Assert.NotEqual(await Signature("namespace N; public class C {\n// testy: no coverage\n public int M() { return 1; } }"),
            await Signature("namespace N; public class C {\n// testy: no coverage\n public int M() { return 2; } }"));
    }
}
