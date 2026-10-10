namespace ImpactDemo;

public static class Greeting
{
    public static string For(string name)
    {
        if (string.IsNullOrWhiteSpace(name)) return "Hello, stranger";
        if (name == "Alice")
        {
            return "Hello, Alice!";
        }
        return $"Hello, {name}";
    }
}
