using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Emit;
using Testy.Analysis;
using Xunit;

namespace Testy.Backend.Tests;

// SourceLocations maps compiled methods to the file and line of their first sequence point
// through the portable PDB. Each test compiles a small assembly with Roslyn.
public sealed class SourceLocationsTests : IDisposable
{
    private static readonly Lazy<MetadataReference[]> References = new(() =>
        [.. ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!).Split(Path.PathSeparator)
            .Where(path => Path.GetFileName(path) is "System.Private.CoreLib.dll" or "System.Runtime.dll" or "System.Collections.dll" or "System.Threading.Tasks.dll")
            .Select(path => MetadataReference.CreateFromFile(path))]);

    private readonly string directory = Directory.CreateTempSubdirectory("testy-locations-").FullName;

    public void Dispose() => Directory.Delete(directory, recursive: true);

    private string Source(string name, string text)
    {
        var path = Path.Combine(directory, name);
        File.WriteAllText(path, text);
        return path;
    }

    // Compiles the sources (path to text) to <name>.dll, with symbols in the requested form.
    private string Compile(string name, DebugInformationFormat format, params (string Path, string Text)[] sources)
    {
        var trees = sources.Select(source => CSharpSyntaxTree.ParseText(source.Text, path: source.Path, encoding: System.Text.Encoding.UTF8)).ToArray();
        var compilation = CSharpCompilation.Create(name, trees, References.Value,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, optimizationLevel: OptimizationLevel.Debug));
        var dll = Path.Combine(directory, name + ".dll");
        var pdb = Path.Combine(directory, name + ".pdb");
        using (var dllStream = File.Create(dll))
        using (var pdbStream = format == DebugInformationFormat.Embedded ? null : File.Create(pdb))
        {
            var result = compilation.Emit(dllStream, pdbStream, options: new EmitOptions(debugInformationFormat: format, pdbFilePath: pdb));
            Assert.True(result.Success, string.Join("\n", result.Diagnostics));
        }
        return dll;
    }

    private static Dictionary<string, SourceLocations.Location?> Read(string assembly) => SourceLocations.Read(assembly, TestContext.Current.CancellationToken);

    [Theory]
    [InlineData(DebugInformationFormat.PortablePdb)]
    [InlineData(DebugInformationFormat.Embedded)]
    public void ReadsLocationsFromPortableAndEmbeddedSymbols(DebugInformationFormat format)
    {
        var file = Source("a.cs", "namespace N;\npublic class C\n{\n    public int M(int x)\n    {\n        return x;\n    }\n\n    public int P => 1;\n\n    public class Inner\n    {\n        public void Run() { }\n    }\n}\n");
        // A debug build starts a block body at its opening brace.
        var locations = Read(Compile("plain", format, (file, File.ReadAllText(file))));
        Assert.Equal(new SourceLocations.Location(file, 5), locations["N.C.M"]);
        Assert.Equal(new SourceLocations.Location(file, 9), locations["N.C.get_P"]);
        Assert.Equal(new SourceLocations.Location(file, 13), locations["N.C+Inner.Run"]);
        // Compiler-generated constructors have no sequence points, so they are not listed.
        Assert.Equal(["N.C+Inner.Run", "N.C.M", "N.C.get_P"], locations.Keys.Order(StringComparer.Ordinal));
    }

    [Fact]
    public void AbstractMethodsHaveNoLocation()
    {
        var file = Source("a.cs", "public abstract class C\n{\n    public abstract void A();\n    public void B() { }\n}\n");
        var locations = Read(Compile("abstract", DebugInformationFormat.PortablePdb, (file, File.ReadAllText(file))));
        Assert.DoesNotContain("C.A", locations.Keys);
        Assert.Equal(new SourceLocations.Location(file, 4), locations["C.B"]);
    }

    [Fact]
    public void AssemblyWithoutSymbolsIsAnError()
    {
        var file = Source("a.cs", "public class C { public void M() { } }");
        var assembly = Compile("nosymbols", DebugInformationFormat.PortablePdb, (file, File.ReadAllText(file)));
        File.Delete(Path.ChangeExtension(assembly, ".pdb"));
        var error = Assert.Throws<InvalidDataException>(() => Read(assembly));
        Assert.Equal($"No matching portable PDB for {assembly}.", error.Message);
    }

    [Fact]
    public void SymbolsFromAnotherBuildAreRejected()
    {
        var file = Source("a.cs", "public class C { public void M() { } }");
        var assembly = Compile("stale", DebugInformationFormat.PortablePdb, (file, File.ReadAllText(file)));
        var pdb = Path.ChangeExtension(assembly, ".pdb");
        // Same names, different content: the PDB id no longer matches the assembly.
        var other = Source("a.cs", "public class C { public void M() { } public void Extra() { } }");
        var rebuilt = Compile("stale-other", DebugInformationFormat.PortablePdb, (other, File.ReadAllText(other)));
        File.Copy(Path.ChangeExtension(rebuilt, ".pdb"), pdb, overwrite: true);
        Assert.Throws<InvalidDataException>(() => Read(assembly));
    }

    [Fact]
    public void StateMachineMethodsAreReportedAsTheirSourceMethod()
    {
        var file = Source("a.cs", string.Join('\n',
            "using System.Collections.Generic;",
            "using System.Threading.Tasks;",
            "public class C",
            "{",
            "    public async Task<int> Fetch()",
            "    {",
            "        await Task.Yield();",
            "        return 1;",
            "    }",
            "",
            "    public IEnumerable<int> Numbers()",
            "    {",
            "        yield return 1;",
            "    }",
            "}", ""));
        var locations = Read(Compile("machines", DebugInformationFormat.PortablePdb, (file, File.ReadAllText(file))));
        // The generated <Fetch>d__0.MoveNext is mapped back to its kickoff method, not listed under the generated type.
        Assert.DoesNotContain(locations.Keys, key => key.Contains('<', StringComparison.Ordinal) || key.Contains("MoveNext", StringComparison.Ordinal));
        Assert.Contains(locations["C.Fetch"], new[] { new SourceLocations.Location(file, 6), new SourceLocations.Location(file, 7) });
        Assert.Contains(locations["C.Numbers"], new[] { new SourceLocations.Location(file, 12), new SourceLocations.Location(file, 13) });
    }

    [Fact]
    public void OverloadsInOneFileKeepTheFirstLocation()
    {
        var file = Source("a.cs", "public class C\n{\n    public void M(int x) { }\n    public void M(string s) { }\n}\n");
        var locations = Read(Compile("sameFile", DebugInformationFormat.PortablePdb, (file, File.ReadAllText(file))));
        Assert.Equal(new SourceLocations.Location(file, 3), locations["C.M"]);
    }

    [Fact]
    public void OverloadsSplitAcrossFilesAreUnknown()
    {
        var first = Source("a.cs", "public partial class C\n{\n    public void M(int x) { }\n    public void Only() { }\n}\n");
        var second = Source("b.cs", "public partial class C\n{\n    public void M(string s) { }\n}\n");
        var locations = Read(Compile("split", DebugInformationFormat.PortablePdb, (first, File.ReadAllText(first)), (second, File.ReadAllText(second))));
        Assert.True(locations.ContainsKey("C.M"));
        Assert.Null(locations["C.M"]);
        // Unambiguous methods of the same partial class keep their location.
        Assert.Equal(new SourceLocations.Location(first, 4), locations["C.Only"]);
    }

    [Fact]
    public void AnAlreadyCancelledTokenStopsTheRead()
    {
        var file = Source("a.cs", "public class C { public void M() { } }");
        var assembly = Compile("cancelled", DebugInformationFormat.PortablePdb, (file, File.ReadAllText(file)));
        using var cancellation = new CancellationTokenSource(); cancellation.Cancel();
        Assert.Throws<OperationCanceledException>(() => SourceLocations.Read(assembly, cancellation.Token));
    }
}
