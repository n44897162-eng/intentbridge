using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using System.Windows.Automation;

namespace IntentBridge.Executor;

/// <summary>
/// UIA observation and action provider. Coordinates are recorded as evidence
/// only; actions use UI Automation patterns.
/// </summary>
public sealed class UiaProvider : IDisposable
{
    private const int MaxElements = 400;
    private readonly Dictionary<string, AutomationElement> _elements = new(StringComparer.Ordinal);
    private readonly object _gate = new();
    private long _lastStructureChange = Environment.TickCount64;
    private string _scope = string.Empty;
    private string _windowTitle = string.Empty;

    public UiaProvider()
    {
        Automation.AddStructureChangedEventHandler(
            AutomationElement.RootElement,
            TreeScope.Subtree,
            (_, _) => Interlocked.Exchange(ref _lastStructureChange, Environment.TickCount64));
    }

    private AutomationElement? TargetWindow()
    {
        var foreground = Native.GetForegroundWindow();
        if (foreground != IntPtr.Zero)
        {
            var element = AutomationElement.FromHandle(foreground);
            if (element is not null) return element;
        }
        var processName = Environment.GetEnvironmentVariable("IB_APP");
        if (!string.IsNullOrWhiteSpace(processName))
        {
            foreach (var process in Process.GetProcessesByName(processName))
            {
                if (process.MainWindowHandle != IntPtr.Zero)
                {
                    return AutomationElement.FromHandle(process.MainWindowHandle);
                }
            }
        }
        return null;
    }

    private static string ShortControlType(ControlType type) =>
        type.ProgrammaticName.Replace("ControlType.", string.Empty, StringComparison.Ordinal);

    private static string RoleOf(ControlType type) => type.ProgrammaticName switch
    {
        "ControlType.Button" => "button",
        "ControlType.Edit" or "ControlType.Document" => "textbox",
        "ControlType.ComboBox" => "combobox",
        "ControlType.ListItem" => "listitem",
        "ControlType.CheckBox" => "checkbox",
        "ControlType.RadioButton" => "radio",
        "ControlType.Hyperlink" => "link",
        "ControlType.Text" => "text",
        "ControlType.Window" => "window",
        _ => "generic",
    };

    private static string SafeValue(Func<string> read)
    {
        try
        {
            return read();
        }
        catch
        {
            return string.Empty;
        }
    }

    private static string Token(AutomationElement element)
    {
        var type = element.Current.ControlType;
        var automationId = SafeValue(() => element.Current.AutomationId);
        var name = SafeValue(() => element.Current.Name);
        var className = SafeValue(() => element.Current.ClassName);
        if (!string.IsNullOrEmpty(automationId)) return $"{ShortControlType(type).ToLowerInvariant()}#{Slug(automationId)}";
        if (!string.IsNullOrEmpty(className)) return $"{ShortControlType(type).ToLowerInvariant()}.{Slug(className)}";
        if (!string.IsNullOrEmpty(name)) return $"{ShortControlType(type).ToLowerInvariant()}[{Slug(name)}]";
        var parent = TreeWalker.RawViewWalker.GetParent(element);
        if (parent is not null)
        {
            var siblings = Siblings(element);
            if (siblings.Count > 1) return $"{ShortControlType(type).ToLowerInvariant()}:nth-of-type({siblings.IndexOf(element) + 1})";
        }
        return ShortControlType(type).ToLowerInvariant();
    }

    private static string Slug(string value)
    {
        var builder = new StringBuilder(value.Length);
        foreach (var character in value)
        {
            builder.Append(char.IsLetterOrDigit(character) ? character : '-');
        }
        return builder.ToString().Trim('-').ToLowerInvariant();
    }

    private static List<AutomationElement> Siblings(AutomationElement element)
    {
        var siblings = new List<AutomationElement>();
        var parent = TreeWalker.RawViewWalker.GetParent(element);
        if (parent is null) return siblings;
        var child = TreeWalker.RawViewWalker.GetFirstChild(parent);
        while (child is not null)
        {
            if (child.Current.ControlType == element.Current.ControlType) siblings.Add(child);
            child = TreeWalker.RawViewWalker.GetNextSibling(child);
        }
        return siblings;
    }

    private static List<string> PathOf(AutomationElement element)
    {
        var tokens = new List<string>();
        var current = TreeWalker.RawViewWalker.GetParent(element);
        while (current is not null && tokens.Count < 6)
        {
            tokens.Insert(0, Token(current));
            current = TreeWalker.RawViewWalker.GetParent(current);
        }
        return tokens;
    }

    private static bool IsEditable(AutomationElement element)
    {
        try
        {
            return element.TryGetCurrentPattern(ValuePattern.Pattern, out var pattern)
                && !((ValuePattern)pattern).Current.IsReadOnly;
        }
        catch
        {
            return false;
        }
    }

    private static (double x, double y, double w, double h) NormalizedRect(
        AutomationElement element, System.Windows.Rect window)
    {
        var rect = element.Current.BoundingRectangle;
        var width = Math.Max(1.0, window.Width);
        var height = Math.Max(1.0, window.Height);
        return (
            Math.Clamp((rect.X - window.X) / width, 0, 1),
            Math.Clamp((rect.Y - window.Y) / height, 0, 1),
            Math.Clamp(rect.Width / width, 0, 1),
            Math.Clamp(rect.Height / height, 0, 1));
    }

    private static string CandidateId(AutomationElement element, List<string> path)
    {
        var runtime = SafeValue(() => string.Join('.', element.GetRuntimeId()));
        var raw = $"{runtime}|{path.Count}|{string.Join('>', path)}|{SafeValue(() => element.Current.AutomationId)}";
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(raw));
        return "uia-" + Convert.ToHexString(hash.AsSpan(0, 8)).ToLowerInvariant();
    }

    public JsonObject DescribeElement(AutomationElement element, System.Windows.Rect window)
    {
        var path = PathOf(element);
        var candidateId = CandidateId(element, path);
        var name = SafeValue(() => element.Current.Name);
        var automationId = SafeValue(() => element.Current.AutomationId);
        var controlType = ShortControlType(element.Current.ControlType);
        var role = RoleOf(element.Current.ControlType);
        var rect = element.Current.BoundingRectangle;
        var norm = NormalizedRect(element, window);
        var siblings = Siblings(element);
        var dpi = Native.GetDpiForWindow((IntPtr)element.Current.NativeWindowHandle);
        _elements[candidateId] = element;
        return new JsonObject
        {
            ["candidate_id"] = candidateId,
            ["native_identity"] = string.IsNullOrEmpty(automationId)
                ? null
                : new JsonObject { ["kind"] = "uia-automation-id", ["value"] = automationId },
            ["semantic"] = new JsonObject
            {
                ["role"] = role,
                ["name"] = string.IsNullOrEmpty(name) ? null : name,
                ["control_type"] = controlType,
                ["test_id"] = string.IsNullOrEmpty(automationId) ? null : automationId,
                ["text"] = string.IsNullOrEmpty(name) ? null : name,
            },
            ["structure"] = new JsonObject
            {
                ["path"] = new JsonArray(path.Select(item => (JsonNode)JsonValue.Create(item)!).ToArray()),
                ["parent"] = path.Count > 0 ? path[^1] : null,
                ["sibling_index"] = Math.Max(0, siblings.IndexOf(element)),
                ["sibling_count"] = siblings.Count,
            },
            ["visual"] = new JsonObject
            {
                ["norm_rect"] = new JsonObject
                {
                    ["x"] = norm.x,
                    ["y"] = norm.y,
                    ["w"] = norm.w,
                    ["h"] = norm.h,
                },
                ["device_scale"] = dpi > 0 ? dpi / 96.0 : 1.0,
            },
            ["context"] = new JsonObject
            {
                ["app_scope"] = _scope,
                ["window_title"] = _windowTitle,
            },
            ["visible"] = !element.Current.IsOffscreen,
            ["enabled"] = element.Current.IsEnabled,
            ["editable"] = IsEditable(element),
            ["in_viewport"] = !element.Current.IsOffscreen,
            ["rect"] = new JsonObject
            {
                ["x"] = rect.X,
                ["y"] = rect.Y,
                ["w"] = rect.Width,
                ["h"] = rect.Height,
            },
            ["text"] = string.IsNullOrEmpty(name) ? null : name,
        };
    }

    private void RefreshScope(AutomationElement window)
    {
        try
        {
            var processId = window.Current.ProcessId;
            var process = Process.GetProcessById(processId);
            _scope = process.ProcessName;
            _windowTitle = SafeValue(() => window.Current.Name);
        }
        catch
        {
            _scope = string.Empty;
            _windowTitle = string.Empty;
        }
    }

    public JsonObject Scope()
    {
        lock (_gate)
        {
            var window = TargetWindow();
            if (window is null) return new JsonObject { ["ok"] = false, ["code"] = "APP_SCOPE_VIOLATION" };
            RefreshScope(window);
            return new JsonObject { ["app_scope"] = _scope, ["window_title"] = _windowTitle };
        }
    }

    public JsonObject Snapshot()
    {
        lock (_gate)
        {
            var window = TargetWindow();
            if (window is null)
            {
                return new JsonObject { ["error"] = new JsonObject { ["code"] = "TARGET_NOT_FOUND", ["message"] = "no foreground window" } };
            }
            RefreshScope(window);
            var windowRect = window.Current.BoundingRectangle;
            var candidates = new JsonArray();
            var walker = TreeWalker.RawViewWalker;
            var stack = new Stack<AutomationElement>();
            stack.Push(window);
            var visited = 0;
            while (stack.Count > 0 && visited < MaxElements)
            {
                var current = stack.Pop();
                visited++;
                try
                {
                    var candidate = DescribeElement(current, windowRect);
                    if (candidate["visible"]?.GetValue<bool>() == true) candidates.Add(candidate);
                    var child = walker.GetFirstChild(current);
                    var children = new List<AutomationElement>();
                    while (child is not null && children.Count < 200)
                    {
                        children.Add(child);
                        child = walker.GetNextSibling(child);
                    }
                    for (var index = children.Count - 1; index >= 0; index--) stack.Push(children[index]);
                }
                catch (ElementNotAvailableException)
                {
                    // Window rebuilt mid-walk: stop and let the engine re-resolve.
                    break;
                }
            }
            return new JsonObject
            {
                ["candidates"] = candidates,
                ["url"] = _scope,
                ["origin"] = _scope,
                ["title"] = _windowTitle,
                ["window_stable_ms"] = Environment.TickCount64 - Interlocked.Read(ref _lastStructureChange),
            };
        }
    }

    public JsonObject Facts()
    {
        var snapshot = Snapshot();
        return new JsonObject
        {
            ["url"] = snapshot["url"],
            ["origin"] = snapshot["origin"],
            ["title"] = snapshot["title"],
            ["window_stable_ms"] = snapshot["window_stable_ms"],
            ["elements"] = snapshot["candidates"],
            ["app_scope"] = snapshot["origin"],
            ["window_title"] = snapshot["title"],
        };
    }

    public JsonObject Act(JsonNode request)
    {
        lock (_gate)
        {
            var action = request["action"]?.GetValue<string>() ?? string.Empty;
            var expectedScope = request["app_scope"]?.GetValue<string>();
            var paramsNode = request["params"] as JsonObject ?? new JsonObject();
            try
            {
                if (action == "launch")
                {
                    var appId = paramsNode["app_id"]?.GetValue<string>();
                    if (string.IsNullOrWhiteSpace(appId)) return Error("INVALID_IR", "launch app_id missing");
                    Process.Start(new ProcessStartInfo(appId) { UseShellExecute = true });
                    var deadline = Environment.TickCount64 + 20_000;
                    while (Environment.TickCount64 < deadline)
                    {
                        var window = TargetWindow();
                        if (window is not null)
                        {
                            RefreshScope(window);
                            Interlocked.Exchange(ref _lastStructureChange, Environment.TickCount64);
                            return new JsonObject();
                        }
                        Thread.Sleep(150);
                    }
                    return Error("TIMEOUT", "application window did not appear");
                }
                if (action == "activate")
                {
                    var window = TargetWindow();
                    if (window is null) return Error("TARGET_NOT_FOUND", "no foreground window");
                    var handle = (IntPtr)window.Current.NativeWindowHandle;
                    Native.ShowWindow(handle, Native.SW_RESTORE);
                    Native.SetForegroundWindow(handle);
                    window.SetFocus();
                    return new JsonObject();
                }
                var candidateId = request["candidate_id"]?.GetValue<string>();
                if (candidateId is null || !_elements.TryGetValue(candidateId, out var element))
                {
                    return Error("STALE_TARGET", "candidate is not attached");
                }
                if (!string.IsNullOrEmpty(expectedScope))
                {
                    var window = TargetWindow();
                    if (window is not null) RefreshScope(window);
                    if (!string.Equals(_scope, expectedScope, StringComparison.OrdinalIgnoreCase))
                    {
                        return Error("APP_SCOPE_VIOLATION", $"expected {expectedScope}, foreground {_scope}");
                    }
                }
                switch (action)
                {
                    case "click":
                    {
                        if (element.TryGetCurrentPattern(InvokePattern.Pattern, out var invoke))
                        {
                            ((InvokePattern)invoke).Invoke();
                            return new JsonObject();
                        }
                        if (element.TryGetCurrentPattern(TogglePattern.Pattern, out var toggle))
                        {
                            ((TogglePattern)toggle).Toggle();
                            return new JsonObject();
                        }
                        return Error("UNSUPPORTED_CAPABILITY", "element exposes no invoke/toggle pattern");
                    }
                    case "input":
                    {
                        if (!element.TryGetCurrentPattern(ValuePattern.Pattern, out var valuePattern))
                        {
                            return Error("UNSUPPORTED_CAPABILITY", "element exposes no value pattern");
                        }
                        var value = (ValuePattern)valuePattern;
                        if (value.Current.IsReadOnly) return Error("PRECONDITION_FAILED", "element is read-only");
                        element.SetFocus();
                        value.SetValue(paramsNode["value"]?.GetValue<string>() ?? string.Empty);
                        return new JsonObject();
                    }
                    case "select":
                    {
                        if (element.TryGetCurrentPattern(SelectionItemPattern.Pattern, out var selection))
                        {
                            ((SelectionItemPattern)selection).Select();
                            return new JsonObject();
                        }
                        return Error("UNSUPPORTED_CAPABILITY", "element exposes no selection pattern");
                    }
                    case "scroll":
                    {
                        if (!element.TryGetCurrentPattern(ScrollPattern.Pattern, out var scroll))
                        {
                            return Error("UNSUPPORTED_CAPABILITY", "element exposes no scroll pattern");
                        }
                        var direction = paramsNode["direction"]?.GetValue<string>() ?? "down";
                        var amount = direction is "up" or "left" ? ScrollAmount.SmallDecrement : ScrollAmount.SmallIncrement;
                        var scrollPattern = (ScrollPattern)scroll;
                        if (direction is "left" or "right") scrollPattern.Scroll(amount, ScrollAmount.NoAmount);
                        else scrollPattern.Scroll(ScrollAmount.NoAmount, amount);
                        return new JsonObject();
                    }
                    case "read-text":
                    {
                        if (element.TryGetCurrentPattern(ValuePattern.Pattern, out var value))
                        {
                            return new JsonObject { ["text"] = ((ValuePattern)value).Current.Value };
                        }
                        if (element.TryGetCurrentPattern(TextPattern.Pattern, out var text))
                        {
                            return new JsonObject { ["text"] = ((TextPattern)text).DocumentRange.GetText(10_000) };
                        }
                        return new JsonObject { ["text"] = SafeValue(() => element.Current.Name) };
                    }
                    default:
                        return Error("UNSUPPORTED_CAPABILITY", $"unsupported action {action}");
                }
            }
            catch (ElementNotAvailableException)
            {
                return Error("STALE_TARGET", "element became unavailable");
            }
            catch (InvalidOperationException error)
            {
                return Error("PRECONDITION_FAILED", error.Message);
            }
        }
    }

    public JsonObject CandidateFor(AutomationElement element)
    {
        lock (_gate)
        {
            var window = TargetWindow();
            if (window is null) return new JsonObject();
            RefreshScope(window);
            return DescribeElement(element, window.Current.BoundingRectangle);
        }
    }

    private static JsonObject Error(string code, string message) => new()
    {
        ["error"] = new JsonObject { ["code"] = code, ["message"] = message },
    };

    public void Dispose()
    {
        Automation.RemoveAllEventHandlers();
    }

    private static class Native
    {
        public const int SW_RESTORE = 9;

        [DllImport("user32.dll")]
        public static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        public static extern bool SetForegroundWindow(IntPtr window);

        [DllImport("user32.dll")]
        public static extern bool ShowWindow(IntPtr window, int command);

        [DllImport("user32.dll")]
        public static extern uint GetDpiForWindow(IntPtr window);
    }
}
