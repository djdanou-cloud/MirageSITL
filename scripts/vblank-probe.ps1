# TASK-073 diagnostic (not acceptance evidence): vertical-blank delivery probe.
# Waits on D3DKMTWaitForVerticalBlankEvent for one display - the kernel wait
# Chrome's GpuVSyncThread uses for its frame clock - and records, for every
# wake, the QPC time and the scan line read right after waking, so
# analyze-vblank.mjs can tell how long after the vertical blank each wake came.
# A QPC / system-time pair lets the analyzer align page rAF timestamps
# (performance.timeOrigin + timestamp) with the wakes.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/vblank-probe.ps1 [-Display \\.\DISPLAY1] [-Seconds 60]
#              [-Priority Normal|AboveNormal|Highest] [-HighPriorityClass] -Out FILE.json
param(
  [string]$Display = '\\.\DISPLAY1',
  [ValidateRange(1, 3600)][int]$Seconds = 60,
  [ValidateSet('Normal', 'AboveNormal', 'Highest')][string]$Priority = 'AboveNormal',
  [switch]$HighPriorityClass,
  [Parameter(Mandatory = $true)][string]$Out
)
$code = @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class MirageVBlankProbe {
  [StructLayout(LayoutKind.Sequential)] public struct LUID { public uint LowPart; public int HighPart; }
  [StructLayout(LayoutKind.Sequential)] public struct OpenFromHdc { public IntPtr hDc; public uint hAdapter; public LUID AdapterLuid; public uint VidPnSourceId; }
  [StructLayout(LayoutKind.Sequential)] public struct WaitVBlank { public uint hAdapter; public uint hDevice; public uint VidPnSourceId; }
  [StructLayout(LayoutKind.Sequential)] public struct ScanLine { public uint hAdapter; public uint VidPnSourceId; [MarshalAs(UnmanagedType.U1)] public bool InVerticalBlank; public uint Line; }
  [StructLayout(LayoutKind.Sequential)] public struct CloseAdapter { public uint hAdapter; }
  [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateDCW(string driver, string device, string output, IntPtr init);
  [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr hdc);
  [DllImport("gdi32.dll")] static extern int D3DKMTOpenAdapterFromHdc(ref OpenFromHdc p);
  [DllImport("gdi32.dll")] static extern int D3DKMTWaitForVerticalBlankEvent(ref WaitVBlank p);
  [DllImport("gdi32.dll")] static extern int D3DKMTGetScanLine(ref ScanLine p);
  [DllImport("gdi32.dll")] static extern int D3DKMTCloseAdapter(ref CloseAdapter p);
  [DllImport("kernel32.dll")] static extern bool QueryPerformanceCounter(out long v);
  [DllImport("kernel32.dll")] static extern bool QueryPerformanceFrequency(out long v);
  [DllImport("kernel32.dll")] static extern void GetSystemTimePreciseAsFileTime(out long v);
  public static string Run(string display, int seconds, ThreadPriority priority) {
    IntPtr hdc = CreateDCW(null, display, null, IntPtr.Zero);
    if (hdc == IntPtr.Zero) throw new Exception("CreateDC failed for " + display);
    var open = new OpenFromHdc { hDc = hdc };
    int opened = D3DKMTOpenAdapterFromHdc(ref open);
    DeleteDC(hdc);
    if (opened != 0) throw new Exception("D3DKMTOpenAdapterFromHdc failed 0x" + opened.ToString("x"));
    Thread.CurrentThread.Priority = priority;
    long freq; QueryPerformanceFrequency(out freq);
    // Preallocated for up to 400 Hz; nothing is allocated while waiting.
    int cap = seconds * 400 + 100;
    long[] wake = new long[cap]; int[] line = new int[cap]; int[] status = new int[cap];
    var wait = new WaitVBlank { hAdapter = open.hAdapter, hDevice = 0, VidPnSourceId = open.VidPnSourceId };
    var scan = new ScanLine { hAdapter = open.hAdapter, VidPnSourceId = open.VidPnSourceId };
    long syncQpc, syncFileTime; QueryPerformanceCounter(out syncQpc); GetSystemTimePreciseAsFileTime(out syncFileTime);
    long end = syncQpc + freq * seconds;
    int n = 0;
    while (n < cap) {
      int waited = D3DKMTWaitForVerticalBlankEvent(ref wait);
      long now; QueryPerformanceCounter(out now);
      int scanned = D3DKMTGetScanLine(ref scan);
      wake[n] = now; line[n] = scanned == 0 ? (int)scan.Line : -1; status[n] = waited;
      n++;
      if (now >= end) break;
    }
    // Scan-line range (vertical total - 1): sample without waiting for 200 ms.
    uint maxLine = 0; long t; long stop = end + freq / 5;
    do { if (D3DKMTGetScanLine(ref scan) == 0 && scan.Line > maxLine) maxLine = scan.Line; QueryPerformanceCounter(out t); } while (t < stop);
    var close = new CloseAdapter { hAdapter = open.hAdapter };
    D3DKMTCloseAdapter(ref close);
    var sb = new StringBuilder();
    sb.Append("{\"schemaVersion\":1,\"display\":\"").Append(display.Replace("\\", "\\\\")).Append("\",\"priority\":\"").Append(priority.ToString())
      .Append("\",\"qpcFrequency\":").Append(freq).Append(",\"maxScanLine\":").Append(maxLine).Append(",\"vidPnSourceId\":").Append(open.VidPnSourceId)
      .Append(",\"syncQpc\":").Append(syncQpc).Append(",\"syncFileTime\":").Append(syncFileTime).Append(",\"wakeQpc\":[");
    for (int i = 0; i < n; i++) { if (i > 0) sb.Append(','); sb.Append(wake[i]); }
    sb.Append("],\"line\":[");
    for (int i = 0; i < n; i++) { if (i > 0) sb.Append(','); sb.Append(line[i]); }
    sb.Append("],\"status\":[");
    for (int i = 0; i < n; i++) { if (i > 0) sb.Append(','); sb.Append(status[i]); }
    sb.Append("]}");
    return sb.ToString();
  }
}
"@
Add-Type -TypeDefinition $code -Language CSharp
if ($HighPriorityClass) { [System.Diagnostics.Process]::GetCurrentProcess().PriorityClass = 'High' }
$json = [MirageVBlankProbe]::Run($Display, $Seconds, [System.Threading.ThreadPriority]$Priority)
[System.IO.File]::WriteAllText($Out, $json)
"vblank-probe: wrote $Out"
