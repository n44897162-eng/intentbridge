using System.IO;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Windows.Automation;

namespace IntentBridge.Executor;

/// <summary>
/// Records UIA invoke/focus events as newline-delimited JSON. Values are never
/// captured; the shared editor builds Action IR from these observations.
/// </summary>
public sealed class UiaRecorder : IDisposable
{
    private readonly UiaProvider _provider = new();
    private readonly AutomationEventHandler _invoked;
    private readonly AutomationFocusChangedEventHandler _focused;

    public UiaRecorder()
    {
        _invoked = (sender, _) => Emit("invoke", sender as AutomationElement);
        _focused = (sender, _) => Emit("focus", sender as AutomationElement);
        Automation.AddAutomationEventHandler(
            InvokePattern.InvokedEvent,
            AutomationElement.RootElement,
            TreeScope.Subtree,
            _invoked);
        Automation.AddAutomationFocusChangedEventHandler(_focused);
    }

    private void Emit(string kind, AutomationElement? element)
    {
        if (element is null) return;
        try
        {
            var candidate = _provider.CandidateFor(element);
            var payload = new JsonObject
            {
                ["type"] = "recording-event",
                ["kind"] = kind,
                ["at"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                ["candidate"] = candidate,
                ["scope"] = _provider.Scope()["app_scope"]?.DeepClone(),
            };
            Console.Out.WriteLine(payload.ToJsonString());
            Console.Out.Flush();
        }
        catch
        {
            // A window can close between the event and the snapshot; skip it.
        }
    }

    public async Task StreamAsync(Stream output, CancellationToken cancellationToken)
    {
        // The recorder streams until stdin closes; the host is the lifecycle owner.
        using var reader = new StreamReader(Console.OpenStandardInput(), Encoding.UTF8);
        await reader.ReadLineAsync(cancellationToken);
        await output.FlushAsync(cancellationToken);
    }

    public void Dispose()
    {
        Automation.RemoveAutomationEventHandler(InvokePattern.InvokedEvent, AutomationElement.RootElement, _invoked);
        Automation.RemoveAutomationFocusChangedEventHandler(_focused);
        _provider.Dispose();
    }
}
