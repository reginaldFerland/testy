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

    private async Task Start(int maxLineBytes, int maxRequests, long maxQueuedBytes = AnalyzerServer.DefaultMaxQueuedBytes, int maxQueuedRequests = AnalyzerServer.DefaultMaxQueuedRequests)
    {
        server = AnalyzerServer.RunAsync(requests.Reader.AsStream(), responses.Writer.AsStream(), maxLineBytes, maxRequests, maxQueuedBytes, maxQueuedRequests);
        reader = new StreamReader(responses.Reader.AsStream(), Encoding.UTF8);
        using var ready = await Next();
        Assert.True(ready.RootElement.TryGetProperty("ready", out _));
        Assert.Equal(JsonValueKind.String, ready.RootElement.GetProperty("version").ValueKind);
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
        // A request no worker had started is answered by its cancel, so the answers are not in the order of the ids.
        Assert.Equal([(1L, "cancelled"), (2L, "cancelled")],
            new[] { first, second }.Select(answer => (answer.RootElement.GetProperty("id").GetInt64(), answer.RootElement.GetProperty("error").GetString())).Order());
        Assert.Equal("", await Close());
    }

    [Fact]
    public async Task ACancelledWaitingRequestIsAnsweredAtOnceAndItsIdCanBeReused()
    {
        await Start(AnalyzerServer.DefaultMaxLineBytes, 1);
        // The only worker is busy with 1, so 2 waits; its cancel answers it without waiting for the worker.
        await Send(Slow(1), Slow(2), """{"cancel":2}""");
        using var cancelled = await Next();
        Assert.Equal((2L, "cancelled"), (cancelled.RootElement.GetProperty("id").GetInt64(), cancelled.RootElement.GetProperty("error").GetString()));
        // The id is free again at once: this is a new request, not a duplicate of the cancelled one.
        await Send(Quick(2), """{"cancel":1}""");
        using var first = await Next();
        Assert.Equal((1L, "cancelled"), (first.RootElement.GetProperty("id").GetInt64(), first.RootElement.GetProperty("error").GetString()));
        using var reused = await Next();
        Assert.Equal(2, reused.RootElement.GetProperty("id").GetInt64());
        Assert.True(reused.RootElement.TryGetProperty("result", out _));
        // Nothing was answered twice.
        Assert.Equal("", await Close());
    }

    [Fact]
    public async Task ARunningIdIsNotReusedUntilItAnswers()
    {
        await Start(AnalyzerServer.DefaultMaxLineBytes, 1);
        await Send(Slow(1), Quick(1), """{"cancel":1}""");
        using var answer = await Next();
        Assert.Equal((1L, "cancelled"), (answer.RootElement.GetProperty("id").GetInt64(), answer.RootElement.GetProperty("error").GetString()));
        Assert.Equal("", await Close());
    }

    [Fact]
    public async Task RequestsBeyondTheWaitingBoundAreRefusedAsBusyAndTheRestAreServed()
    {
        await Start(AnalyzerServer.DefaultMaxLineBytes, 1, maxQueuedRequests: 1);
        // One request runs and one may wait, so of the three behind the first, at least two are refused.
        await Send(Slow(1), Slow(2), Slow(3), Slow(4));
        var refused = new List<long>();
        for (var count = 0; count < 2; count++)
        {
            using var answer = await Next();
            var error = answer.RootElement.GetProperty("error");
            Assert.Equal(AnalyzerServer.BusyErrorType, error.GetProperty("type").GetString());
            refused.Add(answer.RootElement.GetProperty("id").GetInt64());
        }
        Assert.All(refused, id => Assert.InRange(id, 2, 4));
        Assert.Equal(2, refused.Distinct().Count());
        await Send("""{"cancel":1}""", """{"cancel":2}""", """{"cancel":3}""", """{"cancel":4}""");
        Assert.NotNull(await Close());
    }

    [Fact]
    public async Task TheWaitingBoundCountsBytesToo()
    {
        await Start(AnalyzerServer.DefaultMaxLineBytes, 1, maxQueuedBytes: 100);
        await Send(Slow(1), Slow(2), Slow(3));
        // Each request is longer than the bound by itself: the first waiting one is still taken, the next is refused.
        using var answer = await Next();
        Assert.Equal(AnalyzerServer.BusyErrorType, answer.RootElement.GetProperty("error").GetProperty("type").GetString());
        await Send("""{"cancel":1}""", """{"cancel":2}""", """{"cancel":3}""");
        Assert.NotNull(await Close());
    }

    [Fact]
    public async Task ANullWorkingDirectoryMeansTheServersOwn()
    {
        await Start(AnalyzerServer.DefaultMaxLineBytes, 4);
        await Send("""{"id":3,"cwd":null,"request":{"aliasSources":[]}}""");
        using var answer = await Next();
        Assert.Equal(3, answer.RootElement.GetProperty("id").GetInt64());
        Assert.True(answer.RootElement.TryGetProperty("result", out _));
        Assert.Equal("", await Close());
    }

    [Theory]
    // Around the reader's 64 KiB buffer, and several buffers long.
    [InlineData(65_000)]
    [InlineData(65_536)]
    [InlineData(65_537)]
    [InlineData(131_072)]
    [InlineData(1_000_000)]
    public async Task LinesThatStraddleTheReadBufferAreParsedWhole(int padding)
    {
        await Start(AnalyzerServer.DefaultMaxLineBytes, 4);
        // The comment is the whole alias source; the answer proves the request arrived intact and the one after it did too.
        var long_ = $$$"""{"id":20,"cwd":{{{Cwd}}},"request":{"aliasSources":["// {{{new string('a', padding)}}}","global using Hidden = System.Diagnostics.DebuggerHiddenAttribute;"]}}""";
        await Send(long_, Quick(21), long_.Replace("\"id\":20", "\"id\":22", StringComparison.Ordinal));
        var answers = new[] { await Next(), await Next(), await Next() };
        try
        {
            Assert.Equal([20L, 21L, 22L], answers.Select(answer => answer.RootElement.GetProperty("id").GetInt64()).Order());
            foreach (var answer in answers.Where(answer => answer.RootElement.GetProperty("id").GetInt64() != 21))
            {
                Assert.Equal(["Hidden"], answer.RootElement.GetProperty("result").EnumerateArray().Select(name => name.GetString()));
            }
        }
        finally { foreach (var answer in answers) { answer.Dispose(); } }
        Assert.Equal("", await Close());
    }

    [Theory]
    // The head of an over-long line is decoded once: a multibyte character cut by the end of the head, or by
    // the end of a read, must not cost the id.
    [InlineData(false)]
    [InlineData(true)]
    public async Task AnOverLongLineWithMultibyteTextAtItsHeadIsStillAnsweredById(bool splitMidCharacter)
    {
        await Start(200, 4);
        var line = "{\"id\":9,\"x\":\"" + string.Concat(Enumerable.Repeat("\u00e9\u65e5", 100)) + "\"}";
        var bytes = Encoding.UTF8.GetBytes(line + "\n");
        // 13 bytes of ASCII, then two- and three-byte characters: byte 256 and the split below fall inside characters.
        var split = splitMidCharacter ? 14 : 100;
        await requests.Writer.AsStream().WriteAsync(bytes.AsMemory(0, split), TestContext.Current.CancellationToken);
        await requests.Writer.AsStream().FlushAsync(TestContext.Current.CancellationToken);
        await requests.Writer.AsStream().WriteAsync(bytes.AsMemory(split), TestContext.Current.CancellationToken);
        await Send(Quick(10));
        using var tooLong = await Next();
        Assert.Equal(9, tooLong.RootElement.GetProperty("id").GetInt64());
        Assert.Equal(typeof(InvalidDataException).FullName, tooLong.RootElement.GetProperty("error").GetProperty("type").GetString());
        using var next = await Next();
        Assert.Equal(10, next.RootElement.GetProperty("id").GetInt64());
        Assert.Equal("", await Close());
    }

    [Fact]
    public async Task AFinalLineOverTheLimitWithoutANewlineIsAnsweredToo()
    {
        await Start(1024, 4);
        await requests.Writer.AsStream().WriteAsync(Encoding.UTF8.GetBytes($$$"""{"id":11,"cwd":{{{Cwd}}},"request":{"aliasSources":["{{{new string('x', 5000)}}}"]}}"""), TestContext.Current.CancellationToken);
        await requests.Writer.CompleteAsync();
        using var answer = await Next();
        Assert.Equal(11, answer.RootElement.GetProperty("id").GetInt64());
        Assert.Equal(typeof(InvalidDataException).FullName, answer.RootElement.GetProperty("error").GetProperty("type").GetString());
        Assert.Equal(0, await server!.WaitAsync(Timeout, TestContext.Current.CancellationToken));
        await responses.Writer.CompleteAsync();
        Assert.Equal("", await reader!.ReadToEndAsync(TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task AFinalLineWithinTheLimitWithoutANewlineIsServed()
    {
        await Start(AnalyzerServer.DefaultMaxLineBytes, 4);
        await requests.Writer.AsStream().WriteAsync(Encoding.UTF8.GetBytes(Quick(12)), TestContext.Current.CancellationToken);
        await requests.Writer.CompleteAsync();
        using var answer = await Next();
        // Closing the input cancels what is still running, so a served request may also end as cancelled.
        Assert.Equal(12, answer.RootElement.GetProperty("id").GetInt64());
        Assert.True(answer.RootElement.TryGetProperty("result", out _) || answer.RootElement.GetProperty("error").GetString() == "cancelled");
        Assert.Equal(0, await server!.WaitAsync(Timeout, TestContext.Current.CancellationToken));
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
