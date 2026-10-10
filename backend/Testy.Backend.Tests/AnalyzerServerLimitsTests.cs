using System.IO.Pipelines;
using System.Text;
using System.Text.Json;
using Testy.Analysis;
using Xunit;

namespace Testy.Backend.Tests;

// The server bounds what a peer can make it hold: a request line over the limit is skipped
// (answered when it names its id), and requests beyond the in-flight cap wait their turn
// instead of being rejected, so the TypeScript side sees the same answers, only later.
public sealed class AnalyzerServerLimitsTests : IDisposable
{
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(60);
    private readonly string directory = Directory.CreateTempSubdirectory("testy-limits-").FullName;
    private readonly Pipe requests = new();
    private readonly Pipe responses = new();
    private StreamReader? reader;
    private Task<int>? server;

    public void Dispose()
    {
        requests.Writer.Complete();
        reader?.Dispose();
        Directory.Delete(directory, recursive: true);
    }

    private async Task Start(int maxLineBytes, int maxRequests)
    {
        server = AnalyzerServer.RunAsync(requests.Reader.AsStream(), responses.Writer.AsStream(), maxLineBytes, maxRequests);
        reader = new StreamReader(responses.Reader.AsStream(), Encoding.UTF8);
        using var ready = await Next();
        Assert.True(ready.RootElement.TryGetProperty("ready", out _));
    }

    private string Cwd => JsonSerializer.Serialize(directory);

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

    private Task<string?> NextLine() => reader!.ReadLineAsync(TestContext.Current.CancellationToken).AsTask().WaitAsync(Timeout);

    private async Task<JsonDocument> Next() => JsonDocument.Parse(await NextLine() ?? throw new EndOfStreamException());

    private async Task<string> Close()
    {
        await requests.Writer.CompleteAsync();
        Assert.Equal(0, await server!.WaitAsync(Timeout, TestContext.Current.CancellationToken));
        await responses.Writer.CompleteAsync();
        return await reader!.ReadToEndAsync(TestContext.Current.CancellationToken);
    }

    [Theory]
    [InlineData(1024, 5000)]
    // Longer than the reader's own buffer, so the line spans several reads.
    [InlineData(100_000, 300_000)]
    public async Task ALineOverTheLimitIsAnsweredByIdAndTheServerKeepsServing(int limit, int length)
    {
        await Start(limit, 4);
        var padding = new string('a', length);
        await Send($$$"""{"id":5,"cwd":{{{Cwd}}},"request":{"files":["{{{padding}}}"],"excludedAliases":[]}}""", Quick(6));
        using var tooLong = await Next();
        Assert.Equal(5, tooLong.RootElement.GetProperty("id").GetInt64());
        var error = tooLong.RootElement.GetProperty("error");
        Assert.Equal(["type", "message"], error.EnumerateObject().Select(property => property.Name));
        Assert.Equal(typeof(InvalidDataException).FullName, error.GetProperty("type").GetString());
        using var next = await Next();
        Assert.Equal(6, next.RootElement.GetProperty("id").GetInt64());
        Assert.True(next.RootElement.TryGetProperty("result", out _));
        Assert.Equal("", await Close());
    }

    [Fact]
    public async Task ALineOverTheLimitWithoutAnIdIsSkipped()
    {
        await Start(1024, 4);
        // Nothing identifies the request, so there is nobody to answer.
        await Send(new string('x', 5000), Quick(7));
        using var answer = await Next();
        Assert.Equal(7, answer.RootElement.GetProperty("id").GetInt64());
        Assert.Equal("", await Close());
    }

    [Fact]
    public async Task ALineExactlyAtTheLimitIsServed()
    {
        var line = Quick(8);
        await Start(Encoding.UTF8.GetByteCount(line), 4);
        await Send(line);
        using var answer = await Next();
        Assert.True(answer.RootElement.TryGetProperty("result", out _));
        Assert.Equal("", await Close());
    }

    [Fact]
    public async Task RequestsBeyondTheCapWaitForAFreeWorker()
    {
        await Start(AnalyzerServer.DefaultMaxLineBytes, 1);
        await Send(Slow(1), Quick(2));
        var first = NextLine();
        // The quick request is not rejected and does not overtake the one occupying the only worker.
        Assert.NotSame(first, await Task.WhenAny(first, Task.Delay(1000, TestContext.Current.CancellationToken)));
        await Send("""{"cancel":1}""");
        using var cancelled = JsonDocument.Parse(await first ?? throw new EndOfStreamException());
        Assert.Equal((1L, "cancelled"), (cancelled.RootElement.GetProperty("id").GetInt64(), cancelled.RootElement.GetProperty("error").GetString()));
        using var queued = await Next();
        Assert.Equal(2, queued.RootElement.GetProperty("id").GetInt64());
        Assert.True(queued.RootElement.TryGetProperty("result", out _));
        Assert.Equal("", await Close());
    }

    [Fact]
    public async Task AWaitingRequestCanBeCancelled()
    {
        await Start(AnalyzerServer.DefaultMaxLineBytes, 1);
        await Send(Slow(1), Slow(2), """{"cancel":2}""", """{"cancel":1}""");
        using var first = await Next();
        using var second = await Next();
        Assert.Equal([(1L, "cancelled"), (2L, "cancelled")],
            new[] { first, second }.Select(answer => (answer.RootElement.GetProperty("id").GetInt64(), answer.RootElement.GetProperty("error").GetString())));
        Assert.Equal("", await Close());
    }

    [Fact]
    public async Task ClosingTheInputCancelsWaitingRequestsToo()
    {
        await Start(AnalyzerServer.DefaultMaxLineBytes, 1);
        await Send(Slow(1), Slow(2));
        var output = await Close();
        Assert.Equal(["""{"id":1,"error":"cancelled"}""", """{"id":2,"error":"cancelled"}"""], output.Split('\n', StringSplitOptions.RemoveEmptyEntries));
    }
}
