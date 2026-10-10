using System.Buffers;
using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading.Channels;

namespace Testy.Analysis;

// Long-lived source analysis over line-delimited JSON (one UTF-8 line each way).
//   in:  {"id":1,"cwd":"/work","request":{...one-shot request...}}   {"cancel":1}
//   out: {"ready":1,"roslyn":"version from directory","version":"helper version"}   {"id":1,"result":<one-shot response>}   {"id":1,"error":{"type":"System.X","message":"text"}}
// Requests run concurrently (at most MaxRequests at a time; the rest wait their turn, still
// cancellable, and a cancelled one is answered at once) and answer in completion order. A line longer
// than MaxLineBytes is skipped and, when it starts with an id, answered with an error. So is a request
// that would grow the waiting queue past MaxQueuedBytes or MaxQueuedRequests, with the error type
// BusyErrorType, which the caller treats as "use another process". A cancelled request
// answers with the error "cancelled". Malformed requests, and requests reusing the id of one
// still running, are logged to stderr and not answered. The process exits when
// stdin closes, so it cannot outlive an extension host that died without cleaning up.
// Only source analysis is served: graph evaluation stays in per-request MSBuild
// processes because its cache validity depends on a fresh evaluation.
static partial class AnalyzerServer
{
    // Far above what the extension sends (a request lists paths and a few small sources) yet
    // finite, so a runaway writer cannot exhaust memory. The extension puts no cap on a request:
    // one lists every source file of the workspace, so this stays generous.
    internal const int DefaultMaxLineBytes = 64 * 1024 * 1024;
    // Requests that wait for a worker keep their parsed line. Past either bound a request is
    // refused with BusyErrorType instead of queued, so a stalled worker cannot make memory grow.
    internal const long DefaultMaxQueuedBytes = 2L * DefaultMaxLineBytes;
    internal const int DefaultMaxQueuedRequests = 1024;
    // Keep in sync with AnalyzerBusy in src/services/analyzerServer.ts.
    internal const string BusyErrorType = "Testy.Analysis.ServerBusy";
    // Each request already fans out to several workers and shares the Cpu slots, so a few
    // times the processor count keeps the machine busy without a task and a parsed document
    // per queued request.
    internal static int DefaultMaxRequests => Math.Max(4, Environment.ProcessorCount * 2);

    [GeneratedRegex("""^\s*\{\s*"id"\s*:\s*(\d{1,18})\s*,""")]
    private static partial Regex LeadingId();

    // The full exception goes to stderr; the caller shows only its type and message.
    static string ErrorBody(Exception exception) => JsonSerializer.Serialize(new ErrorBody(exception.GetType().FullName, exception.Message), AnalysisJson.Default.ErrorBody);

    // A request in the queue. State is claimed exactly once: by a worker that starts it (1) or by
    // a cancel that arrives first (2), and the claimant owns disposal.
    private sealed class Entry(long id, JsonDocument document, byte[] buffer, int size, CancellationTokenSource cancellation)
    {
        public readonly long Id = id;
        public readonly JsonDocument Document = document;
        public readonly CancellationTokenSource Cancellation = cancellation;
        public readonly int Size = size;
        public int State;

        public bool Claim(int by) => Interlocked.CompareExchange(ref State, by, 0) == 0;

        public void Cancel() { try { Cancellation.Cancel(); } catch (ObjectDisposedException) { } }

        // The document reads the pooled line in place, so the line is returned after it.
        public void Dispose() { Cancellation.Dispose(); Document.Dispose(); ArrayPool<byte>.Shared.Return(buffer); }
    }

    public static Task<int> RunAsync(Stream input, Stream output) => RunAsync(input, output, DefaultMaxLineBytes, DefaultMaxRequests);

    public static Task<int> RunAsync(Stream input, Stream output, int maxLineBytes, int maxRequests) =>
        RunAsync(input, output, maxLineBytes, maxRequests, DefaultMaxQueuedBytes, DefaultMaxQueuedRequests);

    public static async Task<int> RunAsync(Stream input, Stream output, int maxLineBytes, int maxRequests, long maxQueuedBytes, int maxQueuedRequests)
    {
        var running = new ConcurrentDictionary<long, Entry>();
        var queue = Channel.CreateUnbounded<Entry>(new() { SingleWriter = true });
        long queuedBytes = 0; var queuedRequests = 0;
        var gate = new SemaphoreSlim(1, 1);
        async Task Write(string line)
        {
            await gate.WaitAsync();
            var count = Encoding.UTF8.GetByteCount(line);
            var bytes = ArrayPool<byte>.Shared.Rent(count + 1);
            try
            {
                Encoding.UTF8.GetBytes(line, bytes);
                bytes[count] = (byte)'\n';
                await output.WriteAsync(bytes.AsMemory(0, count + 1));
                await output.FlushAsync();
            }
            finally { ArrayPool<byte>.Shared.Return(bytes); gate.Release(); }
        }
        async Task TryWrite(string line)
        {
            try { await Write(line); }
            catch (Exception exception) when (exception is IOException or ObjectDisposedException or OperationCanceledException) { /* The host closed the pipe; the read loop sees EOF. */ }
        }
        void Unqueue(Entry entry) { Interlocked.Add(ref queuedBytes, -entry.Size); Interlocked.Decrement(ref queuedRequests); }
        async Task Serve(Entry entry)
        {
            var id = entry.Id;
            string line;
            try
            {
                // Cancelled while it waited for a worker (input closed).
                entry.Cancellation.Token.ThrowIfCancellationRequested();
                var envelope = entry.Document.RootElement;
                var request = envelope.GetProperty("request");
                var cwd = envelope.TryGetProperty("cwd", out var directory) && directory.ValueKind != JsonValueKind.Null ? directory.GetString()! : Directory.GetCurrentDirectory();
                // Provenance binds a response to the exact bytes the caller serialized; they are only rebuilt when asked for.
                var result = await SourceAnalysis.HandleAsync(request, () => Encoding.UTF8.GetBytes(request.GetRawText()), cwd, entry.Cancellation.Token);
                line = $"{{\"id\":{id},\"result\":{result}}}";
            }
            catch (OperationCanceledException) when (entry.Cancellation.IsCancellationRequested) { line = $"{{\"id\":{id},\"error\":\"cancelled\"}}"; }
            catch (Exception exception) { line = $"{{\"id\":{id},\"error\":{ErrorBody(exception)}}}"; Console.Error.WriteLine(exception.ToString()); }
            finally { running.TryRemove(KeyValuePair.Create(id, entry)); entry.Dispose(); }
            await TryWrite(line);
        }
        await Program.VerifyRoslynAsync();
        await Write($"{{\"ready\":1,\"roslyn\":{JsonSerializer.Serialize(SourceAnalysis.Describe(), AnalysisJson.Default.String)},\"version\":{JsonSerializer.Serialize(Program.Version, AnalysisJson.Default.String)}}}");
        var workers = Enumerable.Range(0, Math.Max(1, maxRequests)).Select(_ => Task.Run(async () =>
        {
            await foreach (var entry in queue.Reader.ReadAllAsync())
            {
                // A cancel that came first already answered and disposed it.
                if (!entry.Claim(1)) { continue; }
                Unqueue(entry);
                // Serve answers its own failures; this keeps an unforeseen one from costing the server a worker.
                try { await Serve(entry); }
                catch (Exception exception) { Console.Error.WriteLine(exception.ToString()); }
            }
        })).ToArray();
        var lines = new BoundedLines(input, maxLineBytes);
        while (await lines.ReadAsync() is { } line)
        {
            if (line.TooLong)
            {
                Console.Error.WriteLine($"Skipped a line longer than {maxLineBytes} bytes.");
                // Only a request that names its id can be answered; the id of a running request must not be answered twice.
                if (LeadingId().Match(line.Head) is { Success: true } match && long.Parse(match.Groups[1].Value, System.Globalization.CultureInfo.InvariantCulture) is var id && !running.ContainsKey(id))
                {
                    var error = JsonSerializer.Serialize(new ErrorBody(typeof(InvalidDataException).FullName, $"The request is longer than the limit of {maxLineBytes} bytes."), AnalysisJson.Default.ErrorBody);
                    await TryWrite($"{{\"id\":{id},\"error\":{error}}}");
                }
                continue;
            }
            // Owned here until the entry takes them.
            JsonDocument? document = null; var buffer = line.Buffer;
            try
            {
                if (line.Length == 0) { continue; }
                document = JsonDocument.Parse(buffer!.AsMemory(0, line.Length));
                var root = document.RootElement;
                if (root.TryGetProperty("cancel", out var cancel))
                {
                    if (running.TryGetValue(cancel.GetInt64(), out var target))
                    {
                        // One that no worker has started is answered now: the caller waits for this answer, not for a free worker.
                        if (target.Claim(2))
                        {
                            Unqueue(target); running.TryRemove(KeyValuePair.Create(target.Id, target));
                            var answer = $"{{\"id\":{target.Id},\"error\":\"cancelled\"}}";
                            target.Dispose();
                            await TryWrite(answer);
                        }
                        else { target.Cancel(); }
                    }
                    continue;
                }
                var id = root.GetProperty("id").GetInt64();
                var cancellation = new CancellationTokenSource();
                var entry = new Entry(id, document, buffer!, line.Length, cancellation);
                // An answer carrying a duplicate id would settle the caller's earlier request, so none is sent.
                if (!running.TryAdd(id, entry))
                {
                    cancellation.Dispose();
                    Console.Error.WriteLine($"Ignored a request with the duplicate id {id}.");
                    continue;
                }
                var waiting = Interlocked.Increment(ref queuedRequests); var bytes = Interlocked.Add(ref queuedBytes, line.Length);
                // The first waiting request is always taken: the bound is on what piles up behind busy workers.
                if (waiting > 1 && (waiting > maxQueuedRequests || bytes > maxQueuedBytes))
                {
                    Unqueue(entry); running.TryRemove(KeyValuePair.Create(id, entry));
                    entry.Claim(2); entry.Dispose(); document = null; buffer = null;
                    Console.Error.WriteLine($"Refused request {id}: {waiting - 1} requests ({bytes - line.Length} bytes) are already waiting.");
                    var busy = JsonSerializer.Serialize(new ErrorBody(BusyErrorType, "The analyzer server has too many requests waiting."), AnalysisJson.Default.ErrorBody);
                    await TryWrite($"{{\"id\":{id},\"error\":{busy}}}");
                    continue;
                }
                // Unbounded channel written only here: waiting for a free worker must not stop this loop from reading cancels.
                queue.Writer.TryWrite(entry);
                document = null; buffer = null;
            }
            catch (Exception exception) when (exception is JsonException or KeyNotFoundException or InvalidOperationException or FormatException)
            {
                Console.Error.WriteLine($"Ignored a malformed request: {exception.Message}");
            }
            finally
            {
                document?.Dispose();
                if (buffer is not null) { ArrayPool<byte>.Shared.Return(buffer); }
            }
        }
        foreach (var entry in running.Values) { entry.Cancel(); }
        queue.Writer.Complete();
        await Task.WhenAll(workers);
        return 0;
    }

    // Reads newline-terminated lines of at most `limit` bytes without ever buffering more:
    // a longer line is skipped to its end and reported with only its first bytes. A line is
    // accumulated once, in a pooled buffer that the caller returns to ArrayPool.Shared.
    private sealed class BoundedLines(Stream input, int limit)
    {
        private const int HeadBytes = 256;
        private readonly byte[] buffer = new byte[64 * 1024];
        private int start, end;

        // Buffer is null for a line over the limit (TooLong) and for an empty one.
        public readonly record struct Line(bool TooLong, byte[]? Buffer, int Length, string Head);

        public async Task<Line?> ReadAsync()
        {
            byte[]? current = null;
            var length = 0;
            var tooLong = false;
            var any = false;
            var head = "";
            try
            {
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
                    if (!tooLong && chunk.Length > 0)
                    {
                        if ((long)length + chunk.Length > limit)
                        {
                            tooLong = true;
                            head = Head(current.AsSpan(0, length), chunk);
                            if (current is not null) { ArrayPool<byte>.Shared.Return(current); current = null; }
                        }
                        else
                        {
                            if (current is null) { current = ArrayPool<byte>.Shared.Rent(chunk.Length); }
                            else if (length + chunk.Length > current.Length)
                            {
                                var larger = ArrayPool<byte>.Shared.Rent((int)Math.Min(limit, Math.Max((long)length + chunk.Length, 2L * current.Length)));
                                current.AsSpan(0, length).CopyTo(larger);
                                ArrayPool<byte>.Shared.Return(current); current = larger;
                            }
                            chunk.CopyTo(current.AsSpan(length));
                            length += chunk.Length;
                        }
                    }
                    start += chunk.Length + (newline < 0 ? 0 : 1);
                    if (newline >= 0) { return Finish(); }
                }
            }
            catch { if (current is not null) { ArrayPool<byte>.Shared.Return(current); } throw; }
            Line Finish() { var line = new Line(tooLong, current, length, head); current = null; return line; }
        }

        // Decoded once from one contiguous run, so a character is never cut between the pieces.
        private static string Head(ReadOnlySpan<byte> before, ReadOnlySpan<byte> chunk)
        {
            Span<byte> bytes = stackalloc byte[HeadBytes];
            var count = Math.Min(before.Length, HeadBytes);
            before[..count].CopyTo(bytes);
            var more = Math.Min(chunk.Length, HeadBytes - count);
            chunk[..more].CopyTo(bytes[count..]);
            return Encoding.UTF8.GetString(bytes[..(count + more)]);
        }
    }
}
