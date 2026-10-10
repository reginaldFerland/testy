using System.Text;
using Xunit;

namespace Testy.Backend.Tests;

// ProcessOwner.Quote builds the Windows command line handed to CreateProcessW. The
// child splits it with CommandLineToArgvW semantics (the MSVCRT rules since 2008),
// implemented here as a reference so the round trip runs on any OS.
public class CommandLineQuotingTests
{
    // Parses the arguments that follow the program name.
    internal static List<string> ParseArguments(string line)
    {
        var arguments = new List<string>();
        var position = 0;
        while (true)
        {
            while (position < line.Length && line[position] is ' ' or '\t') { position++; }
            if (position >= line.Length) { return arguments; }
            var argument = new StringBuilder();
            var quoted = false;
            while (position < line.Length)
            {
                var character = line[position];
                if (character == '\\')
                {
                    var slashes = 0;
                    while (position < line.Length && line[position] == '\\') { slashes++; position++; }
                    if (position < line.Length && line[position] == '"')
                    {
                        // 2n backslashes before a quote are n backslashes and the quote acts; 2n+1 are n and a literal quote.
                        argument.Append('\\', slashes / 2);
                        if (slashes % 2 == 1) { argument.Append('"'); position++; }
                    }
                    else { argument.Append('\\', slashes); }
                }
                else if (character == '"')
                {
                    if (quoted && position + 1 < line.Length && line[position + 1] == '"') { argument.Append('"'); position += 2; }
                    else { quoted = !quoted; position++; }
                }
                else if (character is ' ' or '\t' && !quoted) { break; }
                else { argument.Append(character); position++; }
            }
            arguments.Add(argument.ToString());
        }
    }

    public static TheoryData<string> Arguments => new()
    {
        "", " ", "a", "a b", "a  b", "\ta\t", "\"", "\"\"", "a\"b", "\"a\"", "\"a b\"", "a b\"c d", "\\", "\\\\", "a\\", "a b\\", "a b\\\\",
        "\\\"", "\\\\\"", "a\\\"b", "a\\\\\"b", "a\\\\b", "C:\\Program Files\\Dotnet\\", "C:\\Program Files\\Dotnet\\dotnet.exe",
        "--filter-query \"/*/*/*/Name=A&B\"", "x=\"y z\"", "--results-directory", "tab\there", "ünï cödé 日本語", "%PATH%", "^&|<>", "*?",
    };

    [Theory]
    [MemberData(nameof(Arguments))]
    public void RoundTripsOneArgument(string argument)
    {
        Assert.Equal([argument], ParseArguments(ProcessOwner.Quote(argument)));
    }

    [Theory]
    [MemberData(nameof(Arguments))]
    public void RoundTripsNeighbours(string argument)
    {
        string[] arguments = ["dotnet", argument, "", argument, "end\\"];
        Assert.Equal(arguments, ParseArguments(string.Join(" ", arguments.Select(ProcessOwner.Quote))));
    }

    [Fact]
    public void RoundTripsEveryShortStringOverTheHardAlphabet()
    {
        char[] alphabet = ['a', ' ', '"', '\\', '\t'];
        var count = 0;
        for (var length = 0; length <= 6; length++)
        {
            for (var index = 0; index < Math.Pow(alphabet.Length, length); index++)
            {
                var characters = new char[length];
                for (int slot = 0, rest = index; slot < length; slot++, rest /= alphabet.Length) { characters[slot] = alphabet[rest % alphabet.Length]; }
                var argument = new string(characters);
                Assert.Equal([argument], ParseArguments(ProcessOwner.Quote(argument)));
                count++;
            }
        }
        Assert.Equal(19531, count);
    }

    [Theory]
    [InlineData("", "\"\"")]
    [InlineData("a", "\"a\"")]
    [InlineData("a b", "\"a b\"")]
    [InlineData("\"", "\"\\\"\"")]
    [InlineData("a\"b", "\"a\\\"b\"")]
    [InlineData("\\", "\"\\\\\"")]
    [InlineData("C:\\dir\\", "\"C:\\dir\\\\\"")]
    [InlineData("C:\\dir\\x", "\"C:\\dir\\x\"")]
    [InlineData("\\\"", "\"\\\\\\\"\"")]
    public void QuotesExactly(string argument, string expected)
    {
        Assert.Equal(expected, ProcessOwner.Quote(argument));
    }

    [Fact]
    public void ReferenceParserFollowsTheDocumentedRules()
    {
        Assert.Equal(["a b", "c\\d", "e\"f", "g\\", "", "h i"], ParseArguments("\"a b\" c\\d \"e\\\"f\" \"g\\\\\" \"\" h\" \"i"));
        Assert.Equal(["say \"hi\""], ParseArguments("\"say \"\"hi\"\"\""));
        Assert.Equal(["\\\\a"], ParseArguments("\\\\a"));
        Assert.Equal(["\\a"], ParseArguments("\\\\\"a\""));
        Assert.Empty(ParseArguments("   "));
    }
}
