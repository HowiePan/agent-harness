param([Parameter(Mandatory=$true)][string]$LaunchBase64)
$ErrorActionPreference = 'Stop'
# This supervisor owns the Job handle. Closing it kills every descendant.
# The child is created suspended, so it cannot escape before assignment.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
public static class HarnessResourceJob {
  [StructLayout(LayoutKind.Sequential)] struct IO { public ulong a,b,c,d,e,f; }
  [StructLayout(LayoutKind.Sequential)] struct Basic {
    public long processTime,jobTime; public uint flags;
    public UIntPtr minWorking,maxWorking; public uint active;
    public UIntPtr affinity; public uint priority,scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct Extended {
    public Basic basic; public IO io;
    public UIntPtr processMemory,jobMemory,peakProcess,peakJob;
  }
  [StructLayout(LayoutKind.Sequential)] struct Cpu { public uint flags,rate; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
    public uint cb; public string reserved,desktop,title;
    public uint x,y,xSize,ySize,xChars,yChars,fill,flags;
    public ushort show,reserved2; public IntPtr reservedPtr,input,output,error;
  }
  [StructLayout(LayoutKind.Sequential)] struct Info { public IntPtr process,thread; public uint pid,tid; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr a,string n);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr j,int c,IntPtr p,uint n);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr j,IntPtr p);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder cmd,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref Startup start,out Info info);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int n);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr t);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr p,uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateJobObject(IntPtr j,uint code);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr p,uint ms);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr p,out uint code);
  static void Check(bool ok) { if(!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  static void Set<T>(IntPtr job,int kind,T value) {
    int size=Marshal.SizeOf(typeof(T)); IntPtr data=Marshal.AllocHGlobal(size);
    try { Marshal.StructureToPtr(value,data,false); Check(SetInformationJobObject(job,kind,data,(uint)size)); }
    finally { Marshal.FreeHGlobal(data); }
  }
  static string Quote(string s) {
    StringBuilder b=new StringBuilder("\""); int slashes=0;
    foreach(char c in s) {
      if(c=='\\') { slashes++; continue; }
      if(c=='\"') b.Append('\\',slashes*2+1); else b.Append('\\',slashes);
      slashes=0; b.Append(c);
    }
    return b.Append('\\',slashes*2).Append('"').ToString();
  }
  public static int Run(string executable,string[] args,string cwd,ulong memory,uint cpu,uint processes,int timeout,int parentPid) {
    IntPtr job=CreateJobObject(IntPtr.Zero,null); Check(job!=IntPtr.Zero);
    Info info=new Info(); bool assigned=false; Process parent=null;
    try {
      parent=Process.GetProcessById(parentPid);
      IntPtr parentHandle=parent.Handle; // retain identity; PID reuse cannot adopt an unrelated parent
      Extended limits=new Extended();
      limits.basic.flags=0x2000|0x200|0x8; // kill-on-close, job memory, active process limit
      limits.basic.active=processes; limits.jobMemory=(UIntPtr)memory;
      Set(job,9,limits); Set(job,15,new Cpu {flags=1|4,rate=cpu*100});
      Startup start=new Startup(); start.cb=(uint)Marshal.SizeOf(typeof(Startup));
      start.flags=0x100; start.input=GetStdHandle(-10); start.output=GetStdHandle(-11); start.error=GetStdHandle(-12);
      StringBuilder command=new StringBuilder(Quote(executable));
      bool commandShell=System.IO.Path.GetFileName(executable).Equals("cmd.exe",StringComparison.OrdinalIgnoreCase);
      foreach(string arg in args) command.Append(' ').Append(commandShell ? arg : Quote(arg));
      Check(CreateProcess(executable,command,IntPtr.Zero,IntPtr.Zero,true,0x4|0x08000000,IntPtr.Zero,cwd,ref start,out info));
      Check(AssignProcessToJobObject(job,info.process)); assigned=true;
      Check(ResumeThread(info.thread)!=0xffffffff);
      Stopwatch clock=Stopwatch.StartNew();
      while(WaitForSingleObject(info.process,100)==258) {
        if(WaitForSingleObject(parentHandle,0)!=258 || (timeout>0 && clock.ElapsedMilliseconds>timeout)) { TerminateJobObject(job,124); return 124; }
      }
      uint result; Check(GetExitCodeProcess(info.process,out result)); return unchecked((int)result);
    } finally {
      if(info.process!=IntPtr.Zero && !assigned) TerminateProcess(info.process,125);
      if(info.thread!=IntPtr.Zero) CloseHandle(info.thread);
      if(info.process!=IntPtr.Zero) CloseHandle(info.process);
      CloseHandle(job);
      if(parent!=null) parent.Dispose();
    }
  }
}
'@
try {
  $launch = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($LaunchBase64)) | ConvertFrom-Json
  foreach ($property in $launch.childTemporary.PSObject.Properties) {
    [Environment]::SetEnvironmentVariable($property.Name, [string]$property.Value, 'Process')
  }
  exit [HarnessResourceJob]::Run($launch.executable, [string[]]$launch.args, $launch.cwd,
    [uint64]$launch.memoryBytes, [uint32]$launch.cpuPercent, [uint32]$launch.maxProcesses,
    [int]$launch.timeoutMs, [int]$launch.parentPid)
} catch {
  [Console]::Error.WriteLine('RESOURCE_SUPERVISOR_FAILED: ' + $_.Exception.Message)
  exit 125
}
