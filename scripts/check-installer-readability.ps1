# Hosted-only, non-installing inspection of the installer created by this job.
# No display scaling, font installation, locale or personal settings are changed.
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:CI -ne 'true' -or
    $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:GITHUB_REPOSITORY -ne 'tjwlstj/indie-deck' -or
    $env:INDIEDECK_INSTALLER_READABILITY_CI -ne '1' -or -not [IO.Path]::IsPathRooted($env:RUNNER_TEMP) -or
    $env:NODE_TLS_REJECT_UNAUTHORIZED -eq '0') { throw 'Installer probe is restricted to explicitly enabled GitHub-hosted CI.' }
$taskVersion = (Get-Content -LiteralPath (Join-Path $PWD 'package.json') -Raw | ConvertFrom-Json).version
if ($taskVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid installer version.' }
$taskExe = [IO.Path]::GetFullPath((Join-Path $PWD "release\IndieDeck-Setup-$taskVersion-x64.exe"))
if ($env:INDIEDECK_INSTALLER_PROBE_EXE -cne $taskExe -or -not (Test-Path -LiteralPath $taskExe -PathType Leaf)) { throw 'Only the current fixed installer may be probed.' }
$taskParent = (Resolve-Path -LiteralPath $env:RUNNER_TEMP).Path
$taskFixture = Join-Path $taskParent ('indiedeck-installer-font-' + [guid]::NewGuid().ToString('N'))
$taskEvidence = Join-Path $PWD 'out\installer-readability'
New-Item -ItemType Directory -Path $taskFixture | Out-Null
New-Item -ItemType Directory -Path $taskEvidence -Force | Out-Null
$taskInstaller = $null
$taskResult = @{ passed = $false; version = $taskVersion; installationPerformed = $false; controls = @(); multiScaleTested = $false; fontResolutionMethod = 'local font created from each actual wizard control LOGFONT' }
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class IndieDeckInstallerNative {
 public delegate bool EnumWindowProc(IntPtr h, IntPtr l);
 [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct LOGFONT {
  public int Height, Width, Escapement, Orientation, Weight;
  public byte Italic, Underline, StrikeOut, CharacterSet, OutPrecision, ClipPrecision, Quality, PitchAndFamily;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string FaceName;
 }
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowProc c, IntPtr l);
 [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, EnumWindowProc c, IntPtr l);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int mode);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
 [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern IntPtr GetWindowDpiAwarenessContext(IntPtr h);
 [DllImport("user32.dll")] public static extern int GetAwarenessFromDpiAwarenessContext(IntPtr c);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, IntPtr w, IntPtr l, uint flags, uint timeout, out IntPtr result);
 [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
 [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
 [DllImport("gdi32.dll",CharSet=CharSet.Unicode)] public static extern int GetObject(IntPtr h, int size, out LOGFONT font);
 [DllImport("gdi32.dll",CharSet=CharSet.Unicode)] public static extern IntPtr CreateFontIndirect(ref LOGFONT font);
 [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr dc);
 [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr dc, IntPtr h);
 [DllImport("gdi32.dll",CharSet=CharSet.Unicode)] public static extern int GetTextFace(IntPtr dc, int size, StringBuilder face);
 [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr h);
 [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr dc);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] public static extern IntPtr LoadLibraryEx(string name, IntPtr file, uint flags);
 [DllImport("kernel32.dll")] public static extern bool FreeLibrary(IntPtr module);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] public static extern IntPtr FindResource(IntPtr module, IntPtr name, IntPtr type);
 [DllImport("kernel32.dll")] public static extern uint SizeofResource(IntPtr module, IntPtr resource);
 [DllImport("kernel32.dll")] public static extern IntPtr LoadResource(IntPtr module, IntPtr resource);
 [DllImport("kernel32.dll")] public static extern IntPtr LockResource(IntPtr resource);
 public static IntPtr OwnedWizard(uint pid) {
  IntPtr found=IntPtr.Zero;
  EnumWindows((h,l)=>{ uint owner; GetWindowThreadProcessId(h,out owner); if(owner!=pid) return true;
   var c=new StringBuilder(128); GetClassName(h,c,c.Capacity); var t=new StringBuilder(256); GetWindowText(h,t,t.Capacity);
   if(c.ToString()=="#32770" && t.ToString().Contains("IndieDeck")) { found=h; return false; } return true; },IntPtr.Zero);
  return found;
 }
 public static IntPtr[] Children(IntPtr parent) { var all=new List<IntPtr>(); EnumChildWindows(parent,(h,l)=>{all.Add(h);return all.Count<256;},IntPtr.Zero);return all.ToArray(); }
 public static string ResolveLocalFont(ref LOGFONT requested) {
  // GDI handles are process-private: never select the wizard's borrowed HFONT.
  // https://learn.microsoft.com/en-us/windows/win32/sysinfo/gdi-objects
  // Recreate its observed LOGFONT locally and require successful font mapping.
  IntPtr dc=CreateCompatibleDC(IntPtr.Zero);
  if(dc==IntPtr.Zero) throw new InvalidOperationException("Could not create the local font inspection DC.");
  IntPtr local=IntPtr.Zero, prior=IntPtr.Zero; bool selected=false;
  try {
   local=CreateFontIndirect(ref requested);
   if(local==IntPtr.Zero) throw new InvalidOperationException("Could not recreate the actual wizard control LOGFONT locally.");
   prior=SelectObject(dc,local);
   if(prior==IntPtr.Zero || prior==new IntPtr(-1)) throw new InvalidOperationException("Could not select the locally owned font for inspection.");
   selected=true;
   var face=new StringBuilder(64);
   if(GetTextFace(dc,face.Capacity,face)<=0 || face.Length==0) throw new InvalidOperationException("Could not read the locally realized wizard font face.");
   return face.ToString();
  } finally {
   if(selected) SelectObject(dc,prior);
   // Deleting the DC also releases its font selection if restoration failed.
   DeleteDC(dc);
   if(local!=IntPtr.Zero) DeleteObject(local);
  }
 }
}
'@
try {
  # Loading as data/resource never executes the installer entry point.
  $taskModule = [IndieDeckInstallerNative]::LoadLibraryEx($taskExe, [IntPtr]::Zero, 0x22)
  if ($taskModule -eq [IntPtr]::Zero) { throw 'Could not inspect installer resources.' }
  try {
    $taskResource = [IndieDeckInstallerNative]::FindResource($taskModule, [IntPtr]1, [IntPtr]24)
    $taskSize = [IndieDeckInstallerNative]::SizeofResource($taskModule, $taskResource)
    if ($taskResource -eq [IntPtr]::Zero -or $taskSize -le 0 -or $taskSize -gt 65536) { throw 'Installer manifest resource is missing or oversized.' }
    $taskLoaded = [IndieDeckInstallerNative]::LoadResource($taskModule, $taskResource)
    $taskPointer = [IndieDeckInstallerNative]::LockResource($taskLoaded)
    $taskBytes = New-Object byte[] $taskSize
    [Runtime.InteropServices.Marshal]::Copy($taskPointer, $taskBytes, 0, [int]$taskSize)
    $taskXmlText = [Text.Encoding]::UTF8.GetString($taskBytes).Trim([char]0)
    $taskXml = New-Object Xml.XmlDocument
    $taskXml.XmlResolver = $null
    if ($taskXmlText -match '<!DOCTYPE') { throw 'Unexpected installer manifest DTD.' }
    $taskXml.LoadXml($taskXmlText)
    $taskDpiNode = $taskXml.SelectSingleNode("//*[local-name()='dpiAware']")
    $taskResult.manifestDpiAware = $taskDpiNode -and $taskDpiNode.InnerText.Trim().ToLowerInvariant() -eq 'true'
    if (-not $taskResult.manifestDpiAware) { throw 'Compiled installer does not declare DPI awareness.' }
    [IO.File]::WriteAllText((Join-Path $taskEvidence 'manifest.xml'), $taskXmlText, [Text.UTF8Encoding]::new($false))
  } finally { [void][IndieDeckInstallerNative]::FreeLibrary($taskModule) }
  # A normal wizard is created but no navigation/installation button is clicked.
  # All cleanup below is confined to this exact owned Process object/PID.
  $taskPriorTemp=$env:TEMP; $taskPriorTmp=$env:TMP
  try {
    $env:TEMP=$taskFixture; $env:TMP=$taskFixture
    $taskInstaller = Start-Process -FilePath $taskExe -ArgumentList @("/D=$taskFixture\UnusedInstall") -WindowStyle Hidden -PassThru
  } finally { $env:TEMP=$taskPriorTemp; $env:TMP=$taskPriorTmp }
  $taskWindow = [IntPtr]::Zero
  for ($taskN=0; $taskN -lt 100 -and $taskWindow -eq [IntPtr]::Zero; $taskN++) {
    if ($taskInstaller.HasExited) { throw 'Installer exited before displaying its wizard.' }
    $taskWindow = [IndieDeckInstallerNative]::OwnedWizard([uint32]$taskInstaller.Id)
    if ($taskWindow -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 200 }
  }
  if ($taskWindow -eq [IntPtr]::Zero) { throw 'Owned installer wizard was not found.' }
  [void][IndieDeckInstallerNative]::ShowWindow($taskWindow, 4)
  Start-Sleep -Milliseconds 400
  $taskResult.dpi = [IndieDeckInstallerNative]::GetDpiForWindow($taskWindow)
  $taskResult.dpiAwareness = [IndieDeckInstallerNative]::GetAwarenessFromDpiAwarenessContext([IndieDeckInstallerNative]::GetWindowDpiAwarenessContext($taskWindow))
  if ($taskResult.dpi -le 0 -or $taskResult.dpiAwareness -lt 1) { throw 'The actual wizard is DPI-unaware.' }
  foreach ($taskControl in [IndieDeckInstallerNative]::Children($taskWindow)) {
    if (-not [IndieDeckInstallerNative]::IsWindowVisible($taskControl)) { continue }
    $taskClass = [Text.StringBuilder]::new(128); [void][IndieDeckInstallerNative]::GetClassName($taskControl,$taskClass,$taskClass.Capacity)
    if ($taskClass.ToString() -notin @('Button','Static','Edit')) { continue }
    $taskFontHandle = [IntPtr]::Zero
    [void][IndieDeckInstallerNative]::SendMessageTimeout($taskControl,0x31,[IntPtr]::Zero,[IntPtr]::Zero,2,1000,[ref]$taskFontHandle)
    if ($taskFontHandle -eq [IntPtr]::Zero) { continue }
    $taskFont = New-Object IndieDeckInstallerNative+LOGFONT
    if ([IndieDeckInstallerNative]::GetObject($taskFontHandle,[Runtime.InteropServices.Marshal]::SizeOf($taskFont),[ref]$taskFont) -le 0) { continue }
    $taskFace = [IndieDeckInstallerNative]::ResolveLocalFont([ref]$taskFont)
    $taskResult.controls += @{ class=$taskClass.ToString(); declaredFace=$taskFont.FaceName; resolvedFace=$taskFace; localFontSelectionVerified=$true; pixelHeight=[Math]::Abs($taskFont.Height); pointSize=[Math]::Round([Math]::Abs($taskFont.Height)*72.0/$taskResult.dpi,2) }
  }
  $taskRect = New-Object IndieDeckInstallerNative+RECT
  [void][IndieDeckInstallerNative]::GetWindowRect($taskWindow,[ref]$taskRect)
  $taskWidth=$taskRect.Right-$taskRect.Left; $taskHeight=$taskRect.Bottom-$taskRect.Top
  if ($taskWidth -le 0 -or $taskHeight -le 0 -or $taskWidth -gt 4096 -or $taskHeight -gt 4096) { throw 'Invalid wizard dimensions.' }
  $taskBitmap = [Drawing.Bitmap]::new($taskWidth,$taskHeight)
  $taskGraphics = [Drawing.Graphics]::FromImage($taskBitmap)
  try {
    $taskHdc=$taskGraphics.GetHdc()
    try { $taskResult.printWindowSucceeded=[IndieDeckInstallerNative]::PrintWindow($taskWindow,$taskHdc,2) }
    finally { $taskGraphics.ReleaseHdc($taskHdc) }
    if ($taskResult.printWindowSucceeded) { $taskBitmap.Save((Join-Path $taskEvidence 'wizard.png'),[Drawing.Imaging.ImageFormat]::Png) }
  } finally { $taskGraphics.Dispose(); $taskBitmap.Dispose() }
  foreach ($taskRequiredClass in @('Button','Static')) {
    $taskMatches = @($taskResult.controls | Where-Object { $_.class -eq $taskRequiredClass -and $_.resolvedFace -eq 'Malgun Gothic' -and [Math]::Abs($_.pointSize-10) -lt 0.6 })
    if ($taskMatches.Count -eq 0) {
      $taskObservedFaces = @($taskResult.controls | Where-Object { $_.class -eq $taskRequiredClass } | ForEach-Object { $_.resolvedFace } | Select-Object -Unique) -join ', '
      throw "The wizard's $taskRequiredClass controls did not resolve to the expected 10 pt Malgun Gothic font. Local font mapper returned [$taskObservedFaces]; the requested font may be unavailable on this runner."
    }
  }
  $taskResult.passed=$true
  Write-Output '[installer-readability] PASS: compiled DPI manifest and actual wizard font verified; no installation performed.'
} catch {
  $taskResult.error=$_.Exception.Message
  throw
} finally {
  if ($taskInstaller -and -not $taskInstaller.HasExited) {
    $taskOwnedWindow=[IndieDeckInstallerNative]::OwnedWizard([uint32]$taskInstaller.Id)
    if ($taskOwnedWindow -ne [IntPtr]::Zero) { [void][IndieDeckInstallerNative]::PostMessage($taskOwnedWindow,0x10,[IntPtr]::Zero,[IntPtr]::Zero) }
    if (-not $taskInstaller.WaitForExit(4000)) { $taskInstaller.Kill(); $taskInstaller.WaitForExit() }
  }
  [IO.File]::WriteAllText((Join-Path $taskEvidence 'result.json'),($taskResult | ConvertTo-Json -Depth 5),[Text.UTF8Encoding]::new($false))
  $taskResolved=[IO.Path]::GetFullPath($taskFixture)
  if ([IO.Path]::GetDirectoryName($taskResolved) -ne $taskParent -or -not [IO.Path]::GetFileName($taskResolved).StartsWith('indiedeck-installer-font-')) { throw 'Refusing unexpected fixture cleanup.' }
  if (Test-Path -LiteralPath (Join-Path $taskResolved 'UnusedInstall\IndieDeck.exe')) { throw 'The inspection unexpectedly installed the application; preserving it for inspection.' }
  Remove-Item -LiteralPath $taskResolved -Recurse -Force
}
