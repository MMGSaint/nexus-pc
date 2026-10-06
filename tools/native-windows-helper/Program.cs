using System.Buffers.Binary;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;

namespace Nexus.NativeHelper;

internal static class Program
{
    private const uint ProcessQueryLimitedInformation = 0x1000;
    private const uint ProcessSetLimitedInformation = 0x0200;
    private const uint CpuSetInfoType = 0;

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeCpuSet
    {
        public uint Id;
        public ushort Group;
        public byte LogicalProcessorIndex;
        public byte CoreIndex;
        public byte LastLevelCacheIndex;
        public byte NumaNodeIndex;
        public byte EfficiencyClass;
        public byte AllFlags;
        public uint Reserved;
        public ulong AllocationTag;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetSystemCpuSetInformation(
        IntPtr information,
        uint bufferLength,
        out uint returnedLength,
        IntPtr process,
        uint flags);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetProcessDefaultCpuSets(
        IntPtr process,
        uint[]? cpuSetIds,
        uint cpuSetIdCount);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetProcessDefaultCpuSets(
        IntPtr process,
        IntPtr cpuSetIds,
        uint cpuSetIdCount,
        out uint requiredIdCount);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(
        uint desiredAccess,
        bool inheritHandle,
        uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

    private sealed record Request(
        string Command,
        int? Pid = null,
        uint[]? CpuSetIds = null);

    private sealed record CpuSetInfo(
        uint Id,
        int Group,
        int LogicalProcessorIndex,
        int CoreIndex,
        int LastLevelCacheIndex,
        int NumaNodeIndex,
        int EfficiencyClass,
        bool Parked,
        bool Allocated,
        bool AllocatedToTargetProcess,
        bool RealTime);

    private static int Main()
    {
        try
        {
            string? line;
            while ((line = Console.ReadLine()) is not null)
            {
                if (string.IsNullOrWhiteSpace(line)) continue;

                Request? request;
                try { request = JsonSerializer.Deserialize<Request>(line); }
                catch (JsonException ex) { WriteError("Invalid request JSON: " + ex.Message); continue; }

                if (request is null || string.IsNullOrWhiteSpace(request.Command))
                {
                    WriteError("command is required");
                    continue;
                }

                try
                {
                    object result = request.Command switch
                    {
                        "topology" => GetTopology(),
                        "foreground" => GetForeground(),
                        "get-default-cpu-sets" => GetDefaultCpuSets(RequirePid(request)),
                        "set-default-cpu-sets" => SetDefaultCpuSets(RequirePid(request), request.CpuSetIds ?? []),
                        _ => throw new ArgumentException("Unknown command: " + request.Command),
                    };
                    Console.WriteLine(JsonSerializer.Serialize(new { ok = true, result }));
                }
                catch (Exception ex)
                {
                    WriteError(ex.Message);
                }
                Console.Out.Flush();
            }
            return 0;
        }
        catch (Exception ex)
        {
            WriteError(ex.Message);
            return 1;
        }
    }

    private static CpuSetInfo[] GetTopology()
    {
        if (!GetSystemCpuSetInformation(IntPtr.Zero, 0, out var required, IntPtr.Zero, 0) &&
            required == 0)
        {
            ThrowLastError("GetSystemCpuSetInformation size query failed");
        }

        var buffer = Marshal.AllocHGlobal(checked((int)required));
        try
        {
            if (!GetSystemCpuSetInformation(buffer, required, out var returned, IntPtr.Zero, 0))
                ThrowLastError("GetSystemCpuSetInformation failed");

            var list = new List<CpuSetInfo>();
            var offset = 0;
            while (offset + 8 <= returned)
            {
                var basePtr = IntPtr.Add(buffer, offset);
                var size = Marshal.ReadInt32(basePtr);
                var type = Marshal.ReadInt32(IntPtr.Add(basePtr, 4));
                if (size < 32 || offset + size > returned) break;

                if (type == CpuSetInfoType)
                {
                    var bytes = new byte[32];
                    Marshal.Copy(basePtr, bytes, 0, 32);
                    var set = ParseCpuSet(bytes);
                    list.Add(new CpuSetInfo(
                        set.Id,
                        set.Group,
                        set.LogicalProcessorIndex,
                        set.CoreIndex,
                        set.LastLevelCacheIndex,
                        set.NumaNodeIndex,
                        set.EfficiencyClass,
                        (set.AllFlags & 0x1) != 0,
                        (set.AllFlags & 0x2) != 0,
                        (set.AllFlags & 0x4) != 0,
                        (set.AllFlags & 0x8) != 0));
                }

                offset += size;
            }

            return list
                .OrderBy(x => x.Group)
                .ThenBy(x => x.LogicalProcessorIndex)
                .ThenBy(x => x.Id)
                .ToArray();
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static NativeCpuSet ParseCpuSet(byte[] bytes) =>
        new()
        {
            Id = BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(8, 4)),
            Group = BinaryPrimitives.ReadUInt16LittleEndian(bytes.AsSpan(12, 2)),
            LogicalProcessorIndex = bytes[14],
            CoreIndex = bytes[15],
            LastLevelCacheIndex = bytes[16],
            NumaNodeIndex = bytes[17],
            EfficiencyClass = bytes[18],
            AllFlags = bytes[19],
            Reserved = BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(20, 4)),
            AllocationTag = BinaryPrimitives.ReadUInt64LittleEndian(bytes.AsSpan(24, 8)),
        };

    private static object GetForeground()
    {
        var window = GetForegroundWindow();
        if (window == IntPtr.Zero) return new { available = false, pid = (int?)null, processName = (string?)null };

        var thread = GetWindowThreadProcessId(window, out var pid);
        if (thread == 0 || pid == 0)
            return new { available = false, pid = (int?)null, processName = (string?)null };

        return new
        {
            available = true,
            pid = (int)pid,
            processName = TryProcessName((int)pid),
        };
    }

    private static object GetDefaultCpuSets(int pid)
    {
        using var handle = OpenProcessHandle(pid, ProcessQueryLimitedInformation);
        if (!GetProcessDefaultCpuSets(handle, IntPtr.Zero, 0, out var required) && required == 0)
            ThrowLastError("GetProcessDefaultCpuSets size query failed");

        if (required == 0) return new { pid, ids = Array.Empty<uint>(), explicitlyAssigned = false };

        var buffer = Marshal.AllocHGlobal(checked((int)(required * sizeof(uint))));
        try
        {
            if (!GetProcessDefaultCpuSets(handle, buffer, required, out var returned))
                ThrowLastError("GetProcessDefaultCpuSets failed");

            var ids = new uint[returned];
            Marshal.Copy(buffer, ids.Select(x => unchecked((int)x)).ToArray(), 0, 0);
            // Marshal.Copy has no uint[] overload; read explicitly to avoid endian/width ambiguity.
            for (var i = 0; i < returned; i++)
                ids[i] = Marshal.ReadInt32(IntPtr.Add(buffer, i * sizeof(uint))) is var value ? unchecked((uint)value) : 0U;

            Array.Sort(ids);
            return new { pid, ids, explicitlyAssigned = ids.Length > 0 };
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    private static object SetDefaultCpuSets(int pid, uint[] ids)
    {
        if (ids.Length > 256) throw new ArgumentException("A process CPU-set assignment may contain at most 256 IDs.");
        var unique = ids.Distinct().OrderBy(x => x).ToArray();
        if (unique.Any(id => id == 0))
            throw new ArgumentException("CPU Set ID 0 is not accepted by the helper.");

        using var handle = OpenProcessHandle(pid, ProcessSetLimitedInformation | ProcessQueryLimitedInformation);
        if (!SetProcessDefaultCpuSets(handle, unique, (uint)unique.Length))
            ThrowLastError("SetProcessDefaultCpuSets failed");

        var observed = GetDefaultCpuSets(pid);
        var observedIds = observed.GetType().GetProperty("ids")?.GetValue(observed) as uint[] ?? [];
        if (!observedIds.SequenceEqual(unique))
            throw new InvalidOperationException("Windows did not verify the requested CPU-set assignment.");

        return new { pid, ids = observedIds, verified = true };
    }

    private static IntPtr OpenProcessHandle(int pid, uint access)
    {
        if (pid <= 0) throw new ArgumentException("pid must be a positive integer");
        var handle = OpenProcess(access, false, checked((uint)pid));
        if (handle == IntPtr.Zero) ThrowLastError("OpenProcess failed for PID " + pid);
        return handle;
    }

    private static string TryProcessName(int pid)
    {
        try { return Process.GetProcessById(pid).ProcessName; }
        catch { return "pid-" + pid; }
    }

    private static int RequirePid(Request request) =>
        request.Pid is > 0 and <= int.MaxValue ? request.Pid.Value : throw new ArgumentException("pid must be a positive integer");

    private static void ThrowLastError(string prefix) =>
        throw new Win32Exception(Marshal.GetLastWin32Error(), prefix);

    private static void WriteError(string message) =>
        Console.WriteLine(JsonSerializer.Serialize(new { ok = false, error = message }));

    private sealed class SafeHandleWrapper : IDisposable
    {
        public IntPtr Handle { get; }
        public SafeHandleWrapper(IntPtr handle) => Handle = handle;
        public void Dispose() { if (Handle != IntPtr.Zero) CloseHandle(Handle); }
    }

    private static SafeHandleWrapper OpenProcessHandle(int pid, uint access, bool _ = false) => new(OpenProcessHandleRaw(pid, access));
    private static IntPtr OpenProcessHandleRaw(int pid, uint access) => OpenProcess(access, false, checked((uint)pid));
}
