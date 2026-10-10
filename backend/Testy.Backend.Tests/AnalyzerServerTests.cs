using System.IO.Pipelines;
using System.Text;
using System.Text.Json;
using Testy.Analysis;
using Xunit;

namespace Testy.Backend.Tests;

// src/services/analyzerServer.ts settles a pending request by the id of each answer, so the
// server must answer every accepted request exactly once, never answer for a request it did
// not accept, and keep serving after a line it cannot use.
public sealed class AnalyzerServerTests : IDisposable
{
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(60);
    private readonly string directory = Directory.CreateTempSubdirectory("testy-server-").FullName;
    private readonly Pipe requests = new();
    private readonly Pipe responses = new();
    private readonly StreamReader reader;
    private readonly Task<int> server;

    public AnalyzerServerTests()
    {
        server = AnalyzerServer.RunAsync(requests.Reader.AsStream(), responses.Writer.AsStream());
        reader = new StreamReader(responses.Reader.AsStream(), Encoding.UTF8);
    }

    public void Dispose()
    {
        // End of input stops a server that a failed test left running.
        requests.Writer.Complete();
        reader.Dispose();
        Directory.Delete(directory, recursive: true);
    }

    private string Cwd => JsonSerializer.Serialize(directory);

    // A request that keeps the server busy for far longer than any test waits for it.
    private string Slow(long id)
    {
        var source = new StringBuilder("class C {\n");
        for (var index = 0; index < 2000; index++) { source.Append("    int M").Append(index).Append("(int x) { return x + ").Append(index).Append("; }\n"); }
        File.WriteAllText(Path.Combine(directory, "big.cs"), source.Append('}').ToString());
        var files = JsonSerializer.Serialize(Enumerable.Repeat("big.cs", 5000));
        return $$$"""{"id":{{{id}}},"cwd":{{{Cwd}}},"request":{"files":{{{files}}},"excludedAliases":[]}}""";
    }

    private string Quick(long id) => $$$"""{"id":{{{id}}},"cwd":{{{Cwd}}},"request":{"aliasSources":[]}}""";

    private async Task Send(params string[] lines) =>
        await requests.Writer.AsStream().WriteAsync(Encoding.UTF8.GetBytes(string.Concat(lines.Select(line => line + "\n"))), TestContext.Current.CancellationToken);

    private async Task<JsonDocument> Next() =>
        JsonDocument.Parse(await reader.ReadLineAsync(TestContext.Current.CancellationToken).AsTask().WaitAsync(Timeout) ?? throw new EndOfStreamException());

    // Closes stdin, waits for the server to exit and returns whatever it wrote after the answers already read.
    private async Task<string> Close()
    {
        await requests.Writer.CompleteAsync();
        Assert.Equal(0, await server.WaitAsync(Timeout, TestContext.Current.CancellationToken));
        await responses.Writer.CompleteAsync();
        return await reader.ReadToEndAsync(TestContext.Current.CancellationToken);
    }

    private static (long Id, string Kind, JsonElement Value) Answer(JsonDocument document)
    {
        var root = document.RootElement;
        var kind = root.TryGetProperty("result", out var value) ? "result" : "error";
        return (root.GetProperty("id").GetInt64(), kind, kind == "result" ? value : root.GetProperty("error"));
    }

    [Fact]
    public async Task MalformedLinesAreSkippedAndTheServerKeepsServing()
    {
        using var ready = await Next();
        await Send("not json", "[1]", """{"id":"x","request":{}}""", """{"request":{}}""", """{"cancel":"x"}""", """{"cancel":99}""", "", Quick(7));
        using var answer = await Next();
        Assert.Equal((7L, "result"), (Answer(answer).Id, Answer(answer).Kind));
        Assert.Equal("", await Close());
    }

    [Fact]
    public async Task ARequestWithoutARequestBodyAnswersWithAnError()
    {
        using var ready = await Next();
        await Send("""{"id":3}""");
        using var answer = await Next();
        var (id, kind, value) = Answer(answer);
        Assert.Equal((3L, "error"), (id, kind));
        Assert.Contains("KeyNotFoundException", value.GetString(), StringComparison.Ordinal);
        Assert.Equal("", await Close());
    }

    [Fact]
    public async Task ACancelledRequestAnswersOnceWithCancelled()
    {
        using var ready = await Next();
        await Send(Slow(1), """{"cancel":1}""");
        using var answer = await Next();
        var (id, kind, value) = Answer(answer);
        Assert.Equal((1L, "error", "cancelled"), (id, kind, value.GetString()));
        // A cancel for a request that has already answered is ignored.
        await Send("""{"cancel":1}""");
        Assert.Equal("", await Close());
    }

    [Fact]
    public async Task ADuplicateIdIsNotAnsweredAndTheOriginalStaysCancellable()
    {
        using var ready = await Next();
        await Send(Slow(1), Quick(1), Quick(2), """{"cancel":1}""");
        using var first = await Next();
        using var second = await Next();
        var answers = new[] { Answer(first), Answer(second) }.OrderBy(answer => answer.Id).ToArray();
        Assert.Equal((1L, "error", "cancelled"), (answers[0].Id, answers[0].Kind, answers[0].Value.GetString()));
        Assert.Equal((2L, "result"), (answers[1].Id, answers[1].Kind));
        Assert.Equal("", await Close());
    }

    [Fact]
    public async Task AnIdCanBeReusedOnceItsRequestHasAnswered()
    {
        using var ready = await Next();
        await Send(Quick(1));
        using var first = await Next();
        await Send(Quick(1));
        using var second = await Next();
        Assert.Equal((1L, "result"), (Answer(first).Id, Answer(first).Kind));
        Assert.Equal((1L, "result"), (Answer(second).Id, Answer(second).Kind));
        Assert.Equal("", await Close());
    }

    [Fact]
    public async Task ClosingTheInputCancelsWhatIsStillRunning()
    {
        using var ready = await Next();
        await Send(Slow(4));
        Assert.Equal("""{"id":4,"error":"cancelled"}""" + "\n", await Close());
    }
}
