using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Testy.Analysis;
using Xunit;

namespace Testy.Backend.Tests;

// Requests share one process-wide bound on CPU-bound work, and no amount of concurrency,
// within a request or across requests, may change what a request answers.
public sealed partial class SourceAnalysisConcurrencyTests : IDisposable
{
    private readonly string directory = Directory.CreateTempSubdirectory("testy-concurrency-").FullName;

    public void Dispose() => Directory.Delete(directory, recursive: true);

    private string[] Sources()
    {
        var files = new List<string>();
        for (var index = 0; index < 48; index++)
        {
            var name = $"f{index}.cs";
            var text = (index % 8) switch
            {
                0 => $"namespace N{index}; public partial class C{index} {{ int M(int x) {{ return x + {index}; }} int P => {index}; }}",
                1 => $"[System.Diagnostics.CodeAnalysis.ExcludeFromCodeCoverage] partial class C{index} {{ void M() {{ }} }}",
                2 => "class {",
                3 => $"class C{index} {{\n#if NEVER\n[ExcludeFromCodeCoverage] class E {{ }}\n#endif\n}}",
                4 => $"/// <summary>Doc {index}</summary>\nclass C{index} {{ // trailing\n int F = {index}; }}",
                5 => $"class C{index} {{ void M() {{\n#line 3 \"mapped.cs\"\n int x = {index}; }} }}",
                6 => $"using Hidden = System.Diagnostics.DebuggerHiddenAttribute;\n[Hidden] class C{index} {{ int M() => {index}; }}",
                _ => $"class C{index} {{ int M() {{ var s = \"{new string('x', index * 100)}\"; return s.Length; }} }}"
            };
            File.WriteAllText(Path.Combine(directory, name), text);
            files.Add(name);
        }
        files.Add("missing.cs");
        return [.. files];
    }

    private async Task<string> Handle(string[] files, int concurrency, bool provenance, bool combined)
    {
        var request = new Dictionary<string, object> { ["files"] = files, ["excludedAliases"] = Array.Empty<string>(), ["concurrency"] = concurrency };
        if (provenance) { request["provenance"] = true; }
        if (combined)
        {
            request["aliasSources"] = new[] { "global using G = System.Diagnostics.DebuggerHiddenAttribute;" };
            request["allFiles"] = files;
        }
        var bytes = JsonSerializer.SerializeToUtf8Bytes(request);
        using var document = JsonDocument.Parse(bytes);
        // The request hash binds the request bytes, which name the concurrency; everything else must match.
        return RequestHash().Replace(await SourceAnalysis.HandleAsync(document.RootElement, bytes, directory, CancellationToken.None), "");
    }

    [GeneratedRegex("\"requestHash\":\"[0-9A-F]{64}\",")]
    private static partial Regex RequestHash();

    [Theory]
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public async Task ConcurrencyDoesNotChangeTheBytesOfTheResponse(bool provenance, bool combined)
    {
        var files = Sources();
        var sequential = await Handle(files, 1, provenance, combined);
        Assert.Contains("\"signature\"", sequential, StringComparison.Ordinal);
        Assert.Equal(sequential, await Handle(files, 2, provenance, combined));
        Assert.Equal(sequential, await Handle(files, Environment.ProcessorCount, provenance, combined));
        Assert.Equal(sequential, await Handle(files, 1000, provenance, combined));
    }

    [Fact]
    public async Task ConcurrentRequestsAnswerAsTheyWouldAlone()
    {
        var files = Sources();
        var alone = await Handle(files, 1, provenance: true, combined: false);
        var together = await Task.WhenAll(Enumerable.Range(0, 6).Select(index => Task.Run(() => Handle(files, 1 + index, provenance: true, combined: false))));
        Assert.All(together, answer => Assert.Equal(alone, answer));
        await AllSlotsReturned();
    }

    [Fact]
    public async Task ACancelledRequestReturnsItsSlots()
    {
        var files = Sources();
        var bytes = JsonSerializer.SerializeToUtf8Bytes(new { files, excludedAliases = Array.Empty<string>(), concurrency = Environment.ProcessorCount });
        using var document = JsonDocument.Parse(bytes);
        using var cancellation = new CancellationTokenSource();
        await cancellation.CancelAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => SourceAnalysis.HandleAsync(document.RootElement, bytes, directory, cancellation.Token));
        await AllSlotsReturned();
    }

    // The limiter is process-wide and other tests share it, so wait for them to finish too.
    private static async Task AllSlotsReturned()
    {
        var deadline = DateTime.UtcNow.AddSeconds(60);
        while (SourceAnalysis.Cpu.CurrentCount != Environment.ProcessorCount && DateTime.UtcNow < deadline) { await Task.Delay(20, TestContext.Current.CancellationToken); }
        Assert.Equal(Environment.ProcessorCount, SourceAnalysis.Cpu.CurrentCount);
    }
}
