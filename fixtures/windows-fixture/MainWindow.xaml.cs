using System.Collections.ObjectModel;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Automation;

namespace IntentBridge.Fixture;

public partial class MainWindow : Window
{
    private readonly ObservableCollection<string> _results = new();
    private readonly string _variant;

    private static readonly string[] Catalog =
    {
        "Alpha 季度报告 · 收入与留存",
        "Beta 客户画像 · 生命周期",
        "Gamma 运营周报 · 转化漏斗",
        "Delta 数据质量 · 缺失值监控",
        "Epsilon 摘要 · 管理层季报",
    };

    public MainWindow()
    {
        InitializeComponent();
        _variant = Environment.GetCommandLineArgs().FirstOrDefault(item => item.StartsWith("--variant=", StringComparison.Ordinal))?.Substring("--variant=".Length) ?? "baseline";
        ApplyVariant();
        Results.ItemsSource = _results;
    }

    private void ApplyVariant()
    {
        VariantLabel.Text = $"variant: {_variant}";
        if (_variant == "renamed")
        {
            KeywordLabel.Text = "查询";
            AutomationProperties.SetAutomationId(KeywordBox, "query-field");
            AutomationProperties.SetName(KeywordBox, "查询");
            AutomationProperties.SetAutomationId(SearchButton, "submit-query");
            SearchButton.Content = "查询";
            AutomationProperties.SetName(SearchButton, "查询");
        }
        if (_variant == "decoy")
        {
            ExtraButton.Visibility = Visibility.Visible;
        }
        if (_variant == "moved")
        {
            // Move the form into the right column; the width collapses.
            FormColumn.Width = new GridLength(0);
            Grid.SetColumn(SearchButton, 1);
        }
    }

    private void OnSearch(object sender, RoutedEventArgs e)
    {
        var keyword = KeywordBox.Text.Trim();
        if (keyword.Length == 0)
        {
            ErrorText.Text = "请输入关键词后再搜索";
            ErrorText.Visibility = Visibility.Visible;
            _results.Clear();
            Summary.Text = string.Empty;
            return;
        }
        ErrorText.Visibility = Visibility.Collapsed;
        _results.Clear();
        foreach (var item in Catalog.Where(item => item.Contains(keyword, StringComparison.OrdinalIgnoreCase)))
        {
            _results.Add(item);
        }
        if (_results.Count == 0) _results.Add($"关于“{keyword}”的结果");
        Summary.Text = $"找到 {_results.Count} 条与“{keyword}”相关的结果";
    }

    private void OnOpenDetail(object sender, RoutedEventArgs e)
    {
        DetailText.Text = Results.SelectedItem?.ToString() ?? Summary.Text;
        DetailDialog.Visibility = Visibility.Visible;
    }

    private void OnCloseDetail(object sender, RoutedEventArgs e)
    {
        DetailDialog.Visibility = Visibility.Collapsed;
    }
}
