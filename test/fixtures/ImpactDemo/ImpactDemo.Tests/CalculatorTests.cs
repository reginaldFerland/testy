using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace ImpactDemo.Tests;

[TestClass]
public class CalculatorTests
{
    [TestMethod]
    [DataRow(1, 2, 3)]
    [DataRow(-1, 1, 0)]
    public void Adds(int a, int b, int expected) => Assert.AreEqual(expected, Calculator.Add(a, b));
}
