using System.Text.Json;
using Xunit;

namespace Testy.Backend.Tests;

// Runs Testy.Analysis.dll as the extension does: `dotnet Testy.Analysis.dll`. The helper is copied
// to a folder without Roslyn (the shipped helper carries none), so it resolves Roslyn through
// RoslynLoader: TESTY_ROSLYN_DIR names the signed Roslyn these tests carry, or an empty directory.
public sealed class AnalysisProcessTests : IDisposable
{
    // Program.SelfTestFailedExitCode; src/services/analyzerServer.ts treats it as fatal.
    private const int SelfTestFailed = 70;
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(60);
    private readonly string directory = Directory.CreateTempSubdirectory("testy-analysis-process-").FullName;
    private readonly string helper;

    public AnalysisProcessTests()
    {
        var folder = Directory.CreateDirectory(Path.Combine(directory, "helper")).FullName;
        foreach (var name in new[] { "Testy.Analysis.dll", "Testy.Analysis.deps.json", "Testy.Analysis.runtimeconfig.json" })
        {
            File.Copy(HelperProcess.Output(name), Path.Combine(folder, name));
        }
        helper = Path.Combine(folder, "Testy.Analysis.dll");
    }

    public void Dispose() => Directory.Delete(directory, recursive: true);

    private static Dictionary<string, string?> WithRoslyn() => new() { ["TESTY_ROSLYN_DIR"] = AppContext.BaseDirectory };

    private Dictionary<string, string?> WithoutRoslyn() => new() { ["TESTY_ROSLYN_DIR"] = Directory.CreateDirectory(Path.Combine(directory, "empty")).FullName };

    private async Task<(string Request, string Response)> Files()
    {
        var request = Path.Combine(directory, "request.json");
        await File.WriteAllTextAsync(request, """{"aliasSources":[]}""", TestContext.Current.CancellationToken);
        return (request, Path.Combine(directory, "response.json"));
    }

    [Fact]
    public async Task OneShotWritesTheResponseFileAndNothingToStdout()
    {
        var (request, response) = await Files();
        var (exitCode, output, error) = await HelperProcess.Run(HelperProcess.Start(helper, [request, response], WithRoslyn()));
        Assert.True(exitCode == 0, error);
        Assert.Equal("", output);
        using var document = JsonDocument.Parse(await File.ReadAllTextAsync(response, TestContext.Current.CancellationToken));
        Assert.Equal(JsonValueKind.Array, document.RootElement.ValueKind);
    }

    [Fact]
    public async Task OneShotWithoutRoslynExitsWithTheSelfTestCode()
    {
        var (request, response) = await Files();
        var (exitCode, output, error) = await HelperProcess.Run(HelperProcess.Start(helper, [request, response], WithoutRoslyn()));
        Assert.Equal(SelfTestFailed, exitCode);
        Assert.Equal("", output);
        Assert.Contains("Roslyn", error, StringComparison.Ordinal);
        Assert.False(File.Exists(response));
    }

    [Fact]
    public async Task OneShotWithBadArgumentsIsAnOrdinaryFailure()
    {
        var (exitCode, _, error) = await HelperProcess.Run(HelperProcess.Start(helper, [], WithRoslyn()));
        Assert.Equal(1, exitCode);
        Assert.Contains("Expected a request file and a response file", error, StringComparison.Ordinal);
    }

    [Fact]
    public async Task TheServerKeepsStdoutForTheProtocolAlone()
    {
        using var process = HelperProcess.Start(helper, ["--server"], WithRoslyn());
        var error = process.StandardError.ReadToEndAsync(TestContext.Current.CancellationToken);
        var ready = await process.StandardOutput.ReadLineAsync(TestContext.Current.CancellationToken).AsTask().WaitAsync(Timeout, TestContext.Current.CancellationToken);
        using (var document = JsonDocument.Parse(ready!)) { Assert.Equal(1, document.RootElement.GetProperty("ready").GetInt32()); }
        await process.StandardInput.WriteLineAsync($$$"""{"id":5,"cwd":{{{JsonSerializer.Serialize(directory)}}},"request":{"aliasSources":[]}}""".AsMemory(), TestContext.Current.CancellationToken);
        await process.StandardInput.FlushAsync(TestContext.Current.CancellationToken);
        var answer = await process.StandardOutput.ReadLineAsync(TestContext.Current.CancellationToken).AsTask().WaitAsync(Timeout, TestContext.Current.CancellationToken);
        using (var document = JsonDocument.Parse(answer!)) { Assert.Equal(5, document.RootElement.GetProperty("id").GetInt64()); }
        process.StandardInput.Close();
        await process.WaitForExitAsync(TestContext.Current.CancellationToken).WaitAsync(Timeout, TestContext.Current.CancellationToken);
        Assert.Equal(0, process.ExitCode);
        Assert.Equal("", await process.StandardOutput.ReadToEndAsync(TestContext.Current.CancellationToken));
        await error;
    }

    [Fact]
    public async Task TheServerWithoutRoslynExitsWithTheSelfTestCodeBeforeReady()
    {
        var (exitCode, output, error) = await HelperProcess.Run(HelperProcess.Start(helper, ["--server"], WithoutRoslyn()));
        Assert.Equal(SelfTestFailed, exitCode);
        Assert.Equal("", output);
        Assert.Contains("Roslyn", error, StringComparison.Ordinal);
    }
}
