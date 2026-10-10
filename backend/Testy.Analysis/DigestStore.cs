using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Testy.Analysis;

// SDK and resolver files are hashed by every graph evaluation, and each evaluation is a
// fresh process. This keeps their digests on disk, one file per SDK, valid for a path only
// while its length and write time are unchanged (the rule the in-process cache follows).
// Anything unreadable, malformed or unwritable only costs a rehash: a digest is never
// trusted from a damaged store, and a store that cannot be saved is skipped.
internal sealed partial class DigestStore
{
    internal sealed record Entry(long Length, long Ticks, string Hash);
    internal sealed record Contents(int Version, Dictionary<string, Entry> Entries);

    private const int Version = 1;
    private readonly string file;
    private readonly Dictionary<string, Entry> loaded;
    // Only what this evaluation asked about is kept: the store never outgrows one SDK's files.
    private readonly ConcurrentDictionary<string, Entry> used = new();

    private DigestStore(string file, Dictionary<string, Entry> loaded) { this.file = file; this.loaded = loaded; }

    [GeneratedRegex("^[0-9a-f]{64}$")]
    private static partial Regex Digest();

    internal static DigestStore Open(string directory, string sdk)
    {
        var name = $"digests-{Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(sdk)))[..16].ToLowerInvariant()}.json";
        var file = Path.Combine(directory, name);
        var entries = new Dictionary<string, Entry>();
        try
        {
            var contents = JsonSerializer.Deserialize(File.ReadAllBytes(file), GraphJson.Default.Contents);
            if (contents is { Version: Version, Entries: { } stored })
            {
                foreach (var (path, entry) in stored)
                {
                    if (entry is { Hash: { } hash } && Digest().IsMatch(hash)) { entries[path] = entry; }
                }
            }
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException or NotSupportedException) { entries.Clear(); }
        return new(file, entries);
    }

    internal string? TryGet(string path, long length, long ticks)
    {
        if (!loaded.TryGetValue(path, out var entry) || entry.Length != length || entry.Ticks != ticks) { return null; }
        used[path] = entry;
        return entry.Hash;
    }

    internal void Add(string path, long length, long ticks, string hash) => used[path] = new(length, ticks, hash);

    // Writes only when the set of valid digests changed. The temporary file is private to this
    // process and renamed over the store, so a concurrent evaluation reads either whole version.
    internal void Save()
    {
        var current = used.OrderBy(pair => pair.Key, StringComparer.Ordinal).ToDictionary(pair => pair.Key, pair => pair.Value);
        if (current.Count == loaded.Count && current.All(pair => loaded.TryGetValue(pair.Key, out var before) && before == pair.Value)) { return; }
        var temporary = $"{file}.{Guid.NewGuid():N}.tmp";
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(file)!);
            File.WriteAllBytes(temporary, JsonSerializer.SerializeToUtf8Bytes(new Contents(Version, current), GraphJson.Default.Contents));
            File.Move(temporary, file, overwrite: true);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            try { File.Delete(temporary); } catch (Exception cleanup) when (cleanup is IOException or UnauthorizedAccessException) { }
        }
    }
}
