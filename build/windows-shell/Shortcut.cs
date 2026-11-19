using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;

namespace Helself.WindowsShell
{
    internal static class ShortcutProgram
    {
        [STAThread]
        public static int Main(string[] args)
        {
            try
            {
                if (args != null && args.Length == 2 && args[0] == "--inspect")
                {
                    Console.WriteLine(ShortcutFiles.Inspect(args[1]).ToJson());
                    return 0;
                }
                ShortcutOptions options = ShortcutOptions.Parse(args);
                ShortcutFiles.Update(options);
                Console.WriteLine("Windows shortcut metadata updated: " + options.Shortcut);
                return 0;
            }
            catch (Exception error)
            {
                Console.Error.WriteLine("Windows shortcut update failed: " + error.Message);
                return 1;
            }
        }
    }

    internal sealed class ShortcutOptions
    {
        public string Shortcut;
        public string Target;
        public string Icon;

        public static ShortcutOptions Parse(string[] args)
        {
            if (args == null || args.Length != 6)
                throw new ArgumentException("Expected --shortcut <absolute .lnk> --target <absolute .exe> --icon <absolute .ico>.");
            Dictionary<string, string> values = new Dictionary<string, string>(StringComparer.Ordinal);
            for (int index = 0; index < args.Length; index += 2)
            {
                string name = args[index];
                if (name != "--shortcut" && name != "--target" && name != "--icon")
                    throw new ArgumentException("Unknown shortcut option: " + name);
                if (values.ContainsKey(name))
                    throw new ArgumentException("Duplicate shortcut option: " + name);
                values.Add(name, args[index + 1]);
            }
            if (!values.ContainsKey("--shortcut") || !values.ContainsKey("--target") || !values.ContainsKey("--icon"))
                throw new ArgumentException("All three shortcut options are required.");
            ShortcutOptions options = new ShortcutOptions
            {
                Shortcut = AbsolutePath(values["--shortcut"], "--shortcut", ".lnk"),
                Target = AbsolutePath(values["--target"], "--target", ".exe"),
                Icon = AbsolutePath(values["--icon"], "--icon", ".ico")
            };
            if (!Directory.Exists(Path.GetDirectoryName(options.Shortcut)))
                throw new DirectoryNotFoundException("Shortcut directory does not exist: " + Path.GetDirectoryName(options.Shortcut));
            if (Directory.Exists(options.Shortcut))
                throw new ArgumentException("Shortcut path points to a directory: " + options.Shortcut);
            if (!File.Exists(options.Target))
                throw new FileNotFoundException("Target executable does not exist: " + options.Target, options.Target);
            if (!File.Exists(options.Icon))
                throw new FileNotFoundException("Shortcut icon does not exist: " + options.Icon, options.Icon);
            return options;
        }

        internal static string AbsolutePath(string path, string option, string extension)
        {
            if (String.IsNullOrWhiteSpace(path))
                throw new ArgumentException(option + " must not be empty.");
            bool drivePath = path.Length >= 3 && Char.IsLetter(path[0]) && path[1] == ':' && (path[2] == '\\' || path[2] == '/');
            bool networkPath = path.StartsWith("\\\\", StringComparison.Ordinal) || path.StartsWith("//", StringComparison.Ordinal);
            if (!drivePath && !networkPath)
                throw new ArgumentException(option + " must be an absolute path: " + path);
            string fullPath = Path.GetFullPath(path);
            if (!String.Equals(Path.GetExtension(fullPath), extension, StringComparison.OrdinalIgnoreCase))
                throw new ArgumentException(option + " must identify a " + extension + " file: " + path);
            return fullPath;
        }
    }

    internal static class ShortcutFiles
    {
        private const int ReadOnly = 0;
        private const int ReadWrite = 2;
        private const uint RawTargetPath = 4;

        public static ShortcutDetails Inspect(string path)
        {
            string shortcut = ShortcutOptions.AbsolutePath(path, "--inspect", ".lnk");
            if (!File.Exists(shortcut))
                throw new FileNotFoundException("Shortcut does not exist: " + shortcut, shortcut);
            object instance = new ShellLink();
            try
            {
                ((IPersistFile)instance).Load(shortcut, ReadOnly);
                IShellLinkW link = (IShellLinkW)instance;
                StringBuilder text = new StringBuilder(32768);
                NativeMethods.Check(link.GetPath(text, text.Capacity, IntPtr.Zero, RawTargetPath), "read shortcut target");
                ShortcutDetails details = new ShortcutDetails { Target = text.ToString() };
                text.Clear();
                NativeMethods.Check(link.GetWorkingDirectory(text, text.Capacity), "read shortcut working directory");
                details.WorkingDirectory = text.ToString();
                text.Clear();
                int iconIndex;
                NativeMethods.Check(link.GetIconLocation(text, text.Capacity, out iconIndex), "read shortcut icon");
                details.IconPath = text.ToString();
                details.IconIndex = iconIndex;
                IPropertyStore properties = (IPropertyStore)instance;
                ushort appIdType;
                details.AppId = ReadProperty(properties, PropertyKey.AppId, out appIdType);
                ushort toastType;
                details.ToastClsid = ReadProperty(properties, PropertyKey.ToastActivator, out toastType);
                details.ToastVariantType = toastType;
                return details;
            }
            finally
            {
                Marshal.FinalReleaseComObject(instance);
            }
        }

        private static string ReadProperty(IPropertyStore store, PropertyKey key, out ushort type)
        {
            PropVariant value;
            NativeMethods.Check(store.GetValue(ref key, out value), "read shortcut property " + key.Id);
            try
            {
                type = value.Type;
                if (value.Type == (ushort)VarEnum.VT_CLSID && value.Pointer != IntPtr.Zero)
                    return ((Guid)Marshal.PtrToStructure(value.Pointer, typeof(Guid))).ToString("B").ToUpperInvariant();
                if (value.Type == (ushort)VarEnum.VT_LPWSTR && value.Pointer != IntPtr.Zero)
                    return Marshal.PtrToStringUni(value.Pointer);
                return null;
            }
            finally
            {
                NativeMethods.Check(NativeMethods.PropVariantClear(ref value), "release inspected shortcut property " + key.Id);
            }
        }

        public static void Update(ShortcutOptions options)
        {
            object instance = new ShellLink();
            try
            {
                IShellLinkW link = (IShellLinkW)instance;
                IPersistFile file = (IPersistFile)instance;
                // Loading the existing link preserves unrelated launch arguments and description.
                if (File.Exists(options.Shortcut)) file.Load(options.Shortcut, ReadWrite);
                NativeMethods.Check(link.SetPath(options.Target), "set shortcut target");
                NativeMethods.Check(link.SetWorkingDirectory(Path.GetDirectoryName(options.Target)), "set shortcut working directory");
                NativeMethods.Check(link.SetIconLocation(options.Icon, 0), "set shortcut icon");
                IPropertyStore properties = (IPropertyStore)instance;
                SetProperty(properties, PropertyKey.AppId, PropVariant.String(ShellIdentity.AppId));
                SetProperty(properties, PropertyKey.ToastActivator, PropVariant.Guid(new Guid(ShellIdentity.ToastActivatorClsid)));
                NativeMethods.Check(properties.Commit(), "commit shortcut identity");
                file.Save(options.Shortcut, true);
            }
            finally
            {
                Marshal.FinalReleaseComObject(instance);
            }
        }

        private static void SetProperty(IPropertyStore store, PropertyKey key, PropVariant value)
        {
            try
            {
                NativeMethods.Check(store.SetValue(ref key, ref value), "set shortcut property " + key.Id);
            }
            finally
            {
                NativeMethods.Check(NativeMethods.PropVariantClear(ref value), "release shortcut property " + key.Id);
            }
        }
    }

    internal sealed class ShortcutDetails
    {
        public string Target;
        public string WorkingDirectory;
        public string IconPath;
        public int IconIndex;
        public string AppId;
        public string ToastClsid;
        public ushort ToastVariantType;

        public string ToJson()
        {
            return "{\"target\":" + Quote(Target) +
                ",\"workingDirectory\":" + Quote(WorkingDirectory) +
                ",\"iconPath\":" + Quote(IconPath) +
                ",\"iconIndex\":" + IconIndex.ToString(CultureInfo.InvariantCulture) +
                ",\"appId\":" + Quote(AppId) +
                ",\"toastClsid\":" + Quote(ToastClsid) +
                ",\"toastVariantType\":" + ToastVariantType.ToString(CultureInfo.InvariantCulture) + "}";
        }

        private static string Quote(string value)
        {
            if (value == null) return "null";
            StringBuilder json = new StringBuilder("\"");
            foreach (char character in value)
            {
                if (character == '"') json.Append("\\\"");
                else if (character == '\\') json.Append("\\\\");
                else if (character < 32 || character >= 127) json.Append("\\u" + ((int)character).ToString("X4", CultureInfo.InvariantCulture));
                else json.Append(character);
            }
            return json.Append('"').ToString();
        }
    }

    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    internal struct PropertyKey
    {
        public Guid Format;
        public uint Id;
        public PropertyKey(uint id)
        {
            Format = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");
            Id = id;
        }
        public static readonly PropertyKey AppId = new PropertyKey(5);
        public static readonly PropertyKey ToastActivator = new PropertyKey(26);
    }

    [StructLayout(LayoutKind.Explicit, Size = 24)]
    internal struct PropVariant
    {
        [FieldOffset(0)] public ushort Type;
        [FieldOffset(8)] public IntPtr Pointer;

        public static PropVariant String(string text)
        {
            return new PropVariant { Type = (ushort)VarEnum.VT_LPWSTR, Pointer = Marshal.StringToCoTaskMemUni(text) };
        }

        public static PropVariant Guid(Guid guid)
        {
            IntPtr pointer = Marshal.AllocCoTaskMem(Marshal.SizeOf(typeof(Guid)));
            try
            {
                Marshal.StructureToPtr(guid, pointer, false);
                return new PropVariant { Type = (ushort)VarEnum.VT_CLSID, Pointer = pointer };
            }
            catch
            {
                Marshal.FreeCoTaskMem(pointer);
                throw;
            }
        }
    }

    internal static class NativeMethods
    {
        [DllImport("ole32.dll")]
        public static extern int PropVariantClear(ref PropVariant value);

        public static void Check(int status, string operation)
        {
            if (status < 0)
                throw new COMException("Cannot " + operation + ": HRESULT 0x" + status.ToString("X8"), status);
        }
    }

    [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
    internal class ShellLink { }

    [ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IShellLinkW
    {
        [PreserveSig] int GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int size, IntPtr findData, uint flags);
        [PreserveSig] int GetIDList(out IntPtr itemList);
        [PreserveSig] int SetIDList(IntPtr itemList);
        [PreserveSig] int GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder description, int size);
        [PreserveSig] int SetDescription([MarshalAs(UnmanagedType.LPWStr)] string description);
        [PreserveSig] int GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder directory, int size);
        [PreserveSig] int SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string directory);
        [PreserveSig] int GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder arguments, int size);
        [PreserveSig] int SetArguments([MarshalAs(UnmanagedType.LPWStr)] string arguments);
        [PreserveSig] int GetHotkey(out short hotkey);
        [PreserveSig] int SetHotkey(short hotkey);
        [PreserveSig] int GetShowCmd(out int command);
        [PreserveSig] int SetShowCmd(int command);
        [PreserveSig] int GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder icon, int size, out int index);
        [PreserveSig] int SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string icon, int index);
        [PreserveSig] int SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string path, uint reserved);
        [PreserveSig] int Resolve(IntPtr window, uint flags);
        [PreserveSig] int SetPath([MarshalAs(UnmanagedType.LPWStr)] string path);
    }

    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IPropertyStore
    {
        [PreserveSig] int GetCount(out uint count);
        [PreserveSig] int GetAt(uint index, out PropertyKey key);
        [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant value);
        [PreserveSig] int SetValue(ref PropertyKey key, ref PropVariant value);
        [PreserveSig] int Commit();
    }
}
