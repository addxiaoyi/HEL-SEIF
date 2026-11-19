using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;
using System.Web.Script.Serialization;

namespace Helself.WindowsShell
{
    internal static class ShortcutTests
    {
        private static int checks;

        [STAThread]
        public static int Main()
        {
            string directory = Path.Combine(Path.GetTempPath(), "helself-shortcut-test-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(directory);
            try
            {
                string target = Path.Combine(directory, "\u8D44\u6599 fixture \uD83D\uDD12.exe");
                string icon = Path.Combine(directory, "\u56FE\u6807 icon.ico");
                string shortcut = Path.Combine(directory, "\u5165\u53E3 shortcut.lnk");
                File.WriteAllBytes(target, new byte[] { 77, 90, 0, 0 });
                File.WriteAllBytes(icon, new byte[] { 0, 0, 1, 0, 0, 0 });
                CreateLegacyShortcut(shortcut, target, icon);
                ShortcutDetails legacy = ShortcutFiles.Inspect(shortcut);
                Check(legacy.ToastVariantType == 0, "legacy shortcut has no toast identity");
                Check(legacy.AppId == null, "legacy shortcut has no AUMID");
                Check(ShortcutProgram.Main(Args(shortcut, target, icon)) == 0, "update legacy shortcut without toast metadata");
                Verify(shortcut, target, icon);
                Inspect(shortcut, target, icon);

                string created = Path.Combine(directory, "new metadata.lnk");
                Check(ShortcutProgram.Main(Args(created, target, icon)) == 0, "create a new temporary shortcut");
                Verify(created, target, icon);
                Inspect(created, target, icon);

                PreserveUnrelatedProperties(shortcut);
                string nextTarget = Path.Combine(directory, "updated.exe");
                string nextIcon = Path.Combine(directory, "updated.ico");
                File.Copy(target, nextTarget);
                File.Copy(icon, nextIcon);
                Check(ShortcutProgram.Main(new string[] { "--icon", nextIcon, "--shortcut", shortcut, "--target", nextTarget }) == 0, "update existing shortcut with reordered options");
                Verify(shortcut, nextTarget, nextIcon);
                ReadUnrelatedProperties(shortcut);
                Inspect(shortcut, nextTarget, nextIcon);

                byte[] before = File.ReadAllBytes(shortcut);
                Reject(new string[0], "missing options");
                Reject(new string[] { "--shortcut", shortcut, "--target" }, "missing option value");
                Reject(new string[] { "--shortcut", shortcut, "--target", nextTarget, "--unknown", nextIcon }, "unknown option");
                Reject(new string[] { "--shortcut", shortcut, "--target", nextTarget, "--target", nextTarget }, "duplicate option");
                Reject(Args("relative.lnk", nextTarget, nextIcon), "relative shortcut");
                Reject(Args(shortcut, "relative.exe", nextIcon), "relative target");
                Reject(Args(shortcut, nextTarget, "relative.ico"), "relative icon");
                Reject(Args(Path.Combine(directory, "fixture.txt"), nextTarget, nextIcon), "wrong shortcut extension");
                Reject(Args(shortcut, Path.Combine(directory, "missing.exe"), nextIcon), "missing executable");
                Reject(Args(shortcut, nextTarget, Path.Combine(directory, "missing.ico")), "missing icon");
                Reject(Args(Path.Combine(directory, "missing", "fixture.lnk"), nextTarget, nextIcon), "missing shortcut directory");
                Reject(new string[] { "--inspect", "relative.lnk" }, "relative inspect shortcut");
                Reject(new string[] { "--inspect", Path.Combine(directory, "missing.lnk") }, "missing inspect shortcut");
                Reject(new string[] { "--inspect", shortcut, "--target", nextTarget }, "inspect with extra options");
                Check(EqualBytes(before, File.ReadAllBytes(shortcut)), "invalid arguments preserve the existing shortcut");
                Console.WriteLine("PASS " + checks + " Windows shortcut checks");
                return 0;
            }
            catch (Exception error)
            {
                Console.Error.WriteLine(error);
                return 1;
            }
            finally
            {
                Directory.Delete(directory, true);
            }
        }

        private static void Inspect(string shortcut, string target, string icon)
        {
            byte[] before = File.ReadAllBytes(shortcut);
            TextWriter previous = Console.Out;
            string json;
            using (StringWriter output = new StringWriter())
            {
                Console.SetOut(output);
                try
                {
                    Check(ShortcutProgram.Main(new string[] { "--inspect", shortcut }) == 0, "inspect existing shortcut");
                    json = output.ToString().TrimEnd('\r', '\n');
                }
                finally
                {
                    Console.SetOut(previous);
                }
            }
            Check(IsAscii(json), "inspect JSON is ASCII for redirected console output");
            Dictionary<string, object> properties = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(json);
            Check(properties.Count == 7, "inspect emits only the seven contracted fields");
            Check((string)properties["target"] == target, "inspect target JSON");
            Check((string)properties["workingDirectory"] == Path.GetDirectoryName(target), "inspect working directory JSON");
            Check((string)properties["iconPath"] == icon, "inspect icon path JSON");
            Check(Convert.ToInt32(properties["iconIndex"]) == 0, "inspect icon index JSON");
            Check((string)properties["appId"] == ShellIdentity.AppId, "inspect AUMID JSON");
            Check(new Guid((string)properties["toastClsid"]) == new Guid(ShellIdentity.ToastActivatorClsid), "inspect toast CLSID JSON");
            Check(Convert.ToInt32(properties["toastVariantType"]) == 72, "inspect raw VT_CLSID JSON");
            Check(EqualBytes(before, File.ReadAllBytes(shortcut)), "inspect leaves all shortcut bytes unchanged");
        }

        private static void CreateLegacyShortcut(string shortcut, string target, string icon)
        {
            object instance = new ShellLink();
            try
            {
                IShellLinkW link = (IShellLinkW)instance;
                NativeMethods.Check(link.SetPath(target), "set legacy target");
                NativeMethods.Check(link.SetWorkingDirectory(Path.GetTempPath()), "set legacy working directory");
                NativeMethods.Check(link.SetIconLocation(icon, 1), "set legacy icon");
                ((IPersistFile)instance).Save(shortcut, true);
            }
            finally
            {
                Marshal.FinalReleaseComObject(instance);
            }
        }

        private static string[] Args(string shortcut, string target, string icon)
        {
            return new string[] { "--shortcut", shortcut, "--target", target, "--icon", icon };
        }

        private static void Check(bool condition, string label)
        {
            if (!condition) throw new Exception("FAIL " + label);
            checks++;
        }

        private static void Verify(string shortcut, string target, string icon)
        {
            object instance = new ShellLink();
            try
            {
                ((IPersistFile)instance).Load(shortcut, 0);
                IShellLinkW link = (IShellLinkW)instance;
                StringBuilder path = new StringBuilder(1024);
                NativeMethods.Check(link.GetPath(path, path.Capacity, IntPtr.Zero, 4), "read test target");
                Check(String.Equals(path.ToString(), target, StringComparison.OrdinalIgnoreCase), "target read back from .lnk");
                path.Clear();
                NativeMethods.Check(link.GetWorkingDirectory(path, path.Capacity), "read test working directory");
                Check(String.Equals(path.ToString(), Path.GetDirectoryName(target), StringComparison.OrdinalIgnoreCase), "working directory read back from .lnk");
                path.Clear();
                int iconIndex;
                NativeMethods.Check(link.GetIconLocation(path, path.Capacity, out iconIndex), "read test icon");
                Check(String.Equals(path.ToString(), icon, StringComparison.OrdinalIgnoreCase), "icon path read back from .lnk");
                Check(iconIndex == 0, "icon index is zero");

                IPropertyStore store = (IPropertyStore)instance;
                PropertyKey key = PropertyKey.AppId;
                PropVariant value;
                NativeMethods.Check(store.GetValue(ref key, out value), "read test AUMID");
                try
                {
                    Check(value.Type == 31, "AUMID uses VT_LPWSTR");
                    Check(Marshal.PtrToStringUni(value.Pointer) == ShellIdentity.AppId, "AUMID read back from .lnk");
                }
                finally
                {
                    NativeMethods.Check(NativeMethods.PropVariantClear(ref value), "release test AUMID");
                }
                key = PropertyKey.ToastActivator;
                NativeMethods.Check(store.GetValue(ref key, out value), "read test toast CLSID");
                try
                {
                    Check(value.Type == 72, "toast identity uses VT_CLSID instead of a string");
                    Guid actual = (Guid)Marshal.PtrToStructure(value.Pointer, typeof(Guid));
                    Check(actual == new Guid(ShellIdentity.ToastActivatorClsid), "toast CLSID read back from .lnk");
                }
                finally
                {
                    NativeMethods.Check(NativeMethods.PropVariantClear(ref value), "release test toast CLSID");
                }
            }
            finally
            {
                Marshal.FinalReleaseComObject(instance);
            }
        }

        private static void PreserveUnrelatedProperties(string shortcut)
        {
            object instance = new ShellLink();
            try
            {
                IPersistFile file = (IPersistFile)instance;
                file.Load(shortcut, 0);
                IShellLinkW link = (IShellLinkW)instance;
                NativeMethods.Check(link.SetDescription("Keep this fixture description"), "set test description");
                NativeMethods.Check(link.SetArguments("--fixture-preserved"), "set test arguments");
                file.Save(shortcut, true);
            }
            finally
            {
                Marshal.FinalReleaseComObject(instance);
            }
        }

        private static void ReadUnrelatedProperties(string shortcut)
        {
            object instance = new ShellLink();
            try
            {
                ((IPersistFile)instance).Load(shortcut, 0);
                IShellLinkW link = (IShellLinkW)instance;
                StringBuilder text = new StringBuilder(1024);
                NativeMethods.Check(link.GetDescription(text, text.Capacity), "read test description");
                Check(text.ToString() == "Keep this fixture description", "existing description is preserved");
                text.Clear();
                NativeMethods.Check(link.GetArguments(text, text.Capacity), "read test arguments");
                Check(text.ToString() == "--fixture-preserved", "existing arguments are preserved");
            }
            finally
            {
                Marshal.FinalReleaseComObject(instance);
            }
        }

        private static void Reject(string[] args, string label)
        {
            TextWriter previous = Console.Error;
            using (StringWriter errors = new StringWriter())
            {
                Console.SetError(errors);
                try
                {
                    Check(ShortcutProgram.Main(args) != 0, label + " returns a failure status");
                    Check(errors.ToString().Contains("Windows shortcut update failed:"), label + " reports context");
                }
                finally
                {
                    Console.SetError(previous);
                }
            }
        }

        private static bool EqualBytes(byte[] first, byte[] second)
        {
            if (first.Length != second.Length) return false;
            for (int index = 0; index < first.Length; index++)
                if (first[index] != second[index]) return false;
            return true;
        }

        private static bool IsAscii(string text)
        {
            foreach (char character in text)
                if (character >= 127) return false;
            return true;
        }
    }
}
