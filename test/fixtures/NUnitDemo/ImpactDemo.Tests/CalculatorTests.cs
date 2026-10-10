using NUnit.Framework;

namespace ImpactDemo.Tests;

public class CalculatorTests
{
    [TestCase(1, 2, 3)]
    [TestCase(-1, 1, 0)]
    public void Adds(int a, int b, int expected) => Assert.That(Calculator.Add(a, b), Is.EqualTo(expected));
}
