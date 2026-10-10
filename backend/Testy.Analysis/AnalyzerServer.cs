using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading.Channels;

namespace Testy.Analysis;

// Long-lived source analysis over line-delimited JSON (one UTF-8 line each way).
//   in:  {"id":1,"cwd":"/work","request":{...one-shot request...}}   {"cancel":1}
//   out: {"ready":1,"roslyn":"version from directory"}   {"id":1,"result":<one-shot response>}   {"id":1,"error":{"type":"System.X","message":"text"}}
// Requests run concurrently (at most MaxRequests at a time; the rest wait their turn, still
// cancellable) and answer in completion order. A line longer than MaxLineBytes is skipped and,
// when it starts with an id, answered with an error. A cancelled request
// answers with the error "cancelled". Malformed requests, and requests reusing the id of one
// still running, are logged to stderr and not answered. The process exits when
// stdin closes, so it cannot outlive an extension host that died without cleaning up.
// Only source analysis is served: graph evaluation stays in per-request MSBuild
// processes because its cache validity depends on a fresh evaluation.
static partial class AnalyzerServer
{
    // Far above what the extension sends (a request lists paths and a few small sources) yet
    // finite, so a runaway writer cannot exhaust memory.
    internal const int DefaultMaxLineBytes = 64 * 1024 * 1024;
    // Each request already fans out to several workers and shares the Cpu slots, so a few
    // times the processor count keeps the machine busy without a task and a parsed document
    // per queued request.
    internal static int DefaultMaxRequests => Math.Max(4, Environment.ProcessorCount * 2);

    [GeneratedRegex("""^\s*\{\s*"id"\s*:\s*(\d{1,18})\s*,""")]
    private static partial Regex LeadingId();

    // The full exception goes to stderr; the caller shows only its type and message.
    static string ErrorBody(Exception exception) => JsonSerializer.Serialize(new ErrorBody(exception.GetType().FullName, exception.Message), AnalysisJson.Default.ErrorBody);

    public static Task<int> RunAsync(Stream input, Stream output) => RunAsync(input, output, DefaultMaxLineBytes, DefaultMaxRequests);

    public static async Task<int> RunAsync(Stream input, Stream output, int maxLineBytes, int maxRequests)
    {
        var running = new ConcurrentDictionary<long, CancellationTokenSource>();
        var queue = Channel.CreateUnbounded<(long Id, JsonDocument Document, CancellationTokenSource Cancellation)>(new() { SingleWriter = true });
        var gate = new SemaphoreSlim(1, 1);
        async Task Write(string line)
        {
            await gate.WaitAsync();
            try
            {
                var bytes = Encoding.UTF8.GetBytes(line + "\n");
                await output.WriteAsync(bytes);
                await output.FlushAsync();
            }
            finally { gate.Release(); }
        }
        async Task Serve(long id, JsonDocument document, CancellationTokenSource cancellation)
        {
            string line;
            try
            {
                // Cancelled while it waited for a worker.
                cancellation.Token.ThrowIfCancellationRequested();
                var envelope = document.RootElement;
                var request = envelope.GetProperty("request");
                var cwd = envelope.TryGetProperty("cwd", out var directory) ? directory.GetString()! : Directory.GetCurrentDirectory();
                // Provenance binds a response to the exact bytes the caller serialized.
                var result = await SourceAnalysis.HandleAsync(request, Encoding.UTF8.GetBytes(request.GetRawText()), cwd, cancellation.Token);
                line = $"{{\"id\":{id},\"result\":{result}}}";
            }
            catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { line = $"{{\"id\":{id},\"error\":\"cancelled\"}}"; }
            catch (Exception exception) { line = $"{{\"id\":{id},\"error\":{ErrorBody(exception)}}}"; Console.Error.WriteLine(exception.ToString()); }
            finally { running.TryRemove(KeyValuePair.Create(id, cancellation)); cancellation.Dispose(); document.Dispose(); }
            try { await Write(line); }
            catch (Exception exception) when (exception is IOException or ObjectDisposedException or OperationCanceledException) { /* The host closed the pipe; the read loop sees EOF. */ }
        }
        await Program.VerifyRoslynAsync();
        await Write($"{{\"ready\":1,\"roslyn\":{JsonSerializer.Serialize(SourceAnalysis.Describe(), AnalysisJson.Default.String)}}}");
        var workers = Enumerable.Range(0, Math.Max(1, maxRequests)).Select(_ => Task.Run(async () =>
        {
            await foreach (var (id, document, cancellation) in queue.Reader.ReadAllAsync())
            {
                // Serve answers its own failures; this keeps an unforeseen one from costing the server a worker.
                try { await Serve(id, document, cancellation); }
                catch (Exception exception) { Console.Error.WriteLine(exception.ToString()); }
            }
        })).ToArray();
        var lines = new BoundedLines(input, maxLineBytes);
        while (await lines.ReadAsync() is { } line)
        {
            if (line.Bytes is null)
            {
                Console.Error.WriteLine($"Skipped a line longer than {maxLineBytes} bytes.");
                // Only a request that names its id can be answered; the id of a running request must not be answered twice.
                if (LeadingId().Match(line.Head) is { Success: true } match && long.Parse(match.Groups[1].Value, System.Globalization.CultureInfo.InvariantCulture) is var id && !running.ContainsKey(id))
                {
                    var error = JsonSerializer.Serialize(new ErrorBody(typeof(InvalidDataException).FullName, $"The request is longer than the limit of {maxLineBytes} bytes."), AnalysisJson.Default.ErrorBody);
                    try { await Write($"{{\"id\":{id},\"error\":{error}}}"); }
                    catch (Exception exception) when (exception is IOException or ObjectDisposedException or OperationCanceledException) { /* The host closed the pipe; the read loop sees EOF. */ }
                }
                continue;
            }
            if (line.Bytes.Length == 0) { continue; }
            // Owned here until Serve takes it.
            JsonDocument? document = null;
            try
            {
                document = JsonDocument.Parse(line.Bytes);
                var root = document.RootElement;
                if (root.TryGetProperty("cancel", out var cancel))
                {
                    if (running.TryGetValue(cancel.GetInt64(), out var target)) { try { target.Cancel(); } catch (ObjectDisposedException) { } }
                    continue;
                }
                var id = root.GetProperty("id").GetInt64();
                var cancellation = new CancellationTokenSource();
                // An answer carrying a duplicate id would settle the caller's earlier request, so none is sent.
                if (!running.TryAdd(id, cancellation))
                {
                    cancellation.Dispose();
                    Console.Error.WriteLine($"Ignored a request with the duplicate id {id}.");
                    continue;
                }
                // Unbounded and written only here: waiting for a free worker must not stop this loop from reading cancels.
                queue.Writer.TryWrite((id, document, cancellation));
                document = null;
            }
            catch (Exception exception) when (exception is JsonException or KeyNotFoundException or InvalidOperationException or FormatException)
            {
                Console.Error.WriteLine($"Ignored a malformed request: {exception.Message}");
            }
            finally { document?.Dispose(); }
        }
        foreach (var source in running.Values) { try { source.Cancel(); } catch (ObjectDisposedException) { } }
        queue.Writer.Complete();
        await Task.WhenAll(workers);
        return 0;
    }

    // Reads newline-terminated lines of at most `limit` bytes without ever buffering more:
    // a longer line is skipped to its end and reported with only its first bytes.
    private sealed class BoundedLines(Stream input, int limit)
    {
        private const int HeadBytes = 256;
        private readonly byte[] buffer = new byte[64 * 1024];
        private int start, end;

        // Bytes is null for a line over the limit. Null at end of input.
        public readonly record struct Line(byte[]? Bytes, string Head);

        public async Task<Line?> ReadAsync()
        {
            var current = new MemoryStream();
            var head = "";
            var tooLong = false;
            var any = false;
            while (true)
            {
                if (start == end)
                {
                    start = 0;
                    end = await input.ReadAsync(buffer);
                    // A last line without its newline still counts.
                    if (end == 0) { return any ? Finish() : null; }
                }
                var available = buffer.AsSpan(start, end - start);
                var newline = available.IndexOf((byte)'\n');
                var chunk = newline < 0 ? available : available[..newline];
                any = true;
                if (!tooLong)
                {
                    if (current.Length + chunk.Length > limit)
                    {
                        tooLong = true;
                        var prefix = current.GetBuffer().AsSpan(0, (int)Math.Min(current.Length, HeadBytes)).ToArray();
                        head = Encoding.UTF8.GetString(prefix) + Encoding.UTF8.GetString(chunk[..Math.Min(chunk.Length, Math.Max(0, HeadBytes - prefix.Length))]);
                        current = new MemoryStream();
                    }
                    else { current.Write(chunk); }
                }
                start += chunk.Length + (newline < 0 ? 0 : 1);
                if (newline >= 0) { return Finish(); }
            }
            Line Finish() => tooLong ? new(null, head) : new(current.ToArray(), "");
        }
    }
}
