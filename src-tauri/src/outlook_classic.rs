// Classic Outlook, read locally through its COM object model — zero accounts,
// zero registration, nothing leaves the machine. Runs a vetted script per
// operation in a hidden PowerShell (the model never composes shell); JSON on
// stdout; a hard timeout so a profile chooser or a permission dialog can
// never hang a run. Attaches to a running Outlook first and only launches it
// when it isn't open. Never calls .Send() — drafts only.
use base64::Engine;
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

const TIMEOUT: Duration = Duration::from_secs(60);

// Every script gets $A (the JSON args, decoded) and returns JSON on stdout.
const PRELUDE: &str = r#"
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$A = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__ARGS__')) | ConvertFrom-Json
function Attach {
  try { return [Runtime.InteropServices.Marshal]::GetActiveObject('Outlook.Application') } catch {}
  return New-Object -ComObject Outlook.Application
}
function SmtpOf($item) {
  try {
    if ($item.SenderEmailType -eq 'EX') {
      $u = $item.Sender.GetExchangeUser(); if ($u) { return $u.PrimarySmtpAddress }
    }
    return $item.SenderEmailAddress
  } catch { return $item.SenderEmailAddress }
}
function Row($m) {
  [ordered]@{
    id = $m.EntryID
    when = $m.ReceivedTime.ToString('yyyy-MM-ddTHH:mm')
    from = $m.SenderName
    address = (SmtpOf $m)
    subject = $m.Subject
    unread = [bool]$m.UnRead
    attachments = $m.Attachments.Count
    preview = ($m.Body -replace '\s+', ' ').Substring(0, [Math]::Min(140, ($m.Body -replace '\s+', ' ').Length))
  }
}
"#;

const DETECT: &str = r#"
$classic = $null
try { $classic = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\OUTLOOK.EXE' -ErrorAction Stop).'(default)' } catch {}
$progid = Test-Path 'HKLM:\SOFTWARE\Classes\Outlook.Application'
$new = @(Get-AppxPackage -Name 'Microsoft.OutlookForWindows' -ErrorAction SilentlyContinue).Count -gt 0
$running = @(Get-Process OUTLOOK -ErrorAction SilentlyContinue).Count -gt 0
[ordered]@{ classic = [bool]($classic -and $progid -and (Test-Path $classic)); newOutlook = $new; running = $running } | ConvertTo-Json -Compress
"#;

const MAIL_RECENT: &str = r#"
$ol = Attach; $ns = $ol.GetNamespace('MAPI')
$folder = if ($A.folder -eq 'sent') { $ns.GetDefaultFolder(5) } else { $ns.GetDefaultFolder(6) }
$items = $folder.Items; $items.Sort('[ReceivedTime]', $true)
$since = (Get-Date).AddHours(-[double]$A.since_hours)
$filter = "[ReceivedTime] >= '" + $since.ToString('g') + "'"
if ($A.unread_only) { $filter += " AND [Unread] = True" }
$sel = $items.Restrict($filter)
$rows = @(); $n = 0
foreach ($m in $sel) {
  if ($m.Class -ne 43) { continue }
  if ($A.from -and (($m.SenderName + ' ' + (SmtpOf $m)) -notmatch [regex]::Escape($A.from))) { continue }
  $rows += (Row $m); $n++
  if ($n -ge [int]$A.limit) { break }
}
[ordered]@{ account = $ns.Accounts.Item(1).SmtpAddress; folder = $folder.Name; rows = $rows } | ConvertTo-Json -Depth 4 -Compress
"#;

const MAIL_SEARCH: &str = r#"
$ol = Attach; $ns = $ol.GetNamespace('MAPI')
$folder = $ns.GetDefaultFolder(6)
$items = $folder.Items; $items.Sort('[ReceivedTime]', $true)
$q = ($A.query -replace "'", "''")
$sel = $items.Restrict("@SQL=""urn:schemas:httpmail:subject"" LIKE '%$q%' OR ""urn:schemas:httpmail:fromname"" LIKE '%$q%' OR ""urn:schemas:httpmail:textdescription"" LIKE '%$q%'")
$rows = @(); $n = 0
foreach ($m in $sel) { if ($m.Class -ne 43) { continue }; $rows += (Row $m); $n++; if ($n -ge [int]$A.limit) { break } }
[ordered]@{ folder = $folder.Name; rows = $rows } | ConvertTo-Json -Depth 4 -Compress
"#;

const MAIL_READ: &str = r#"
$ol = Attach; $ns = $ol.GetNamespace('MAPI')
$m = $ns.GetItemFromID($A.id)
$body = ($m.Body -replace "`r`n", "`n")
if ($body.Length -gt 6000) { $body = $body.Substring(0, 6000) + "`n[… trimmed]" }
[ordered]@{
  id = $m.EntryID; when = $m.ReceivedTime.ToString('yyyy-MM-ddTHH:mm'); from = $m.SenderName; address = (SmtpOf $m)
  to = $m.To; cc = $m.CC; subject = $m.Subject; unread = [bool]$m.UnRead
  attachments = @($m.Attachments | ForEach-Object { $_.FileName })
  body = $body
} | ConvertTo-Json -Depth 4 -Compress
"#;

const CALENDAR: &str = r#"
$ol = Attach; $ns = $ol.GetNamespace('MAPI')
$cal = $ns.GetDefaultFolder(9)
$items = $cal.Items; $items.IncludeRecurrences = $true; $items.Sort('[Start]')
$start = [datetime]$A.start; $end = [datetime]$A.end
$sel = $items.Restrict("[Start] <= '" + $end.ToString('g') + "' AND [End] >= '" + $start.ToString('g') + "'")
$rows = @(); $n = 0
foreach ($e in $sel) {
  $rows += [ordered]@{
    start = $e.Start.ToString('yyyy-MM-ddTHH:mm'); end = $e.End.ToString('yyyy-MM-ddTHH:mm')
    subject = $e.Subject; location = $e.Location; organizer = $e.Organizer; allDay = [bool]$e.AllDayEvent
  }
  $n++; if ($n -ge [int]$A.limit) { break }
}
[ordered]@{ rows = $rows } | ConvertTo-Json -Depth 4 -Compress
"#;

const DRAFT: &str = r#"
$ol = Attach; $ns = $ol.GetNamespace('MAPI')
if ($A.reply_to) {
  $orig = $ns.GetItemFromID($A.reply_to)
  $d = $orig.Reply()
  if ($A.body) { $d.Body = $A.body + "`n`n" + $d.Body }
} else {
  $d = $ol.CreateItem(0)
  if ($A.to) { $d.To = $A.to }
  if ($A.subject) { $d.Subject = $A.subject }
  $d.Body = $A.body
}
$d.Save()
[ordered]@{ id = $d.EntryID; to = $d.To; subject = $d.Subject } | ConvertTo-Json -Compress
"#;

const OPEN_DRAFT: &str = r#"
$ol = Attach; $ns = $ol.GetNamespace('MAPI')
$d = $ns.GetItemFromID($A.id); $d.Display() | Out-Null
[ordered]@{ ok = $true } | ConvertTo-Json -Compress
"#;

fn script_for(op: &str) -> Option<&'static str> {
    Some(match op {
        "detect" => DETECT,
        "mail_recent" => MAIL_RECENT,
        "mail_search" => MAIL_SEARCH,
        "mail_read" => MAIL_READ,
        "calendar" => CALENDAR,
        "draft" => DRAFT,
        "open_draft" => OPEN_DRAFT,
        _ => return None,
    })
}

/// Run one vetted Outlook operation. `args` is a JSON object the script
/// reads as $A. Returns the script's JSON text.
#[tauri::command(async)]
pub fn outlook_classic(op: String, args: String) -> Result<String, String> {
    let body = script_for(&op).ok_or_else(|| format!("Outlook:UnknownOp:{op}"))?;
    let args_b64 = base64::engine::general_purpose::STANDARD.encode(args.as_bytes());
    let script = if op == "detect" {
        DETECT.to_string()
    } else {
        format!("{}\n{}", PRELUDE.replace("__ARGS__", &args_b64), body)
    };
    // -EncodedCommand takes UTF-16LE base64 — no quoting games.
    let utf16: Vec<u8> = script
        .encode_utf16()
        .flat_map(|u| u.to_le_bytes())
        .collect();
    let encoded = base64::engine::general_purpose::STANDARD.encode(&utf16);

    let mut cmd = Command::new("powershell.exe");
    cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        &encoded,
    ]);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd.spawn().map_err(|e| format!("Outlook:Spawn:{e}"))?;

    // Drain pipes on threads so a big body can't deadlock the child.
    let mut out_pipe = child.stdout.take().unwrap();
    let mut err_pipe = child.stderr.take().unwrap();
    let (tx, rx) = mpsc::channel();
    let tx2 = tx.clone();
    std::thread::spawn(move || {
        let mut s = String::new();
        let _ = out_pipe.read_to_string(&mut s);
        let _ = tx.send(("out", s));
    });
    std::thread::spawn(move || {
        let mut s = String::new();
        let _ = err_pipe.read_to_string(&mut s);
        let _ = tx2.send(("err", s));
    });

    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if started.elapsed() > TIMEOUT {
                    let _ = child.kill();
                    return Err("Outlook:Timeout".to_string());
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => return Err(format!("Outlook:Wait:{e}")),
        }
    }
    let mut out = String::new();
    let mut err = String::new();
    for _ in 0..2 {
        if let Ok((which, s)) = rx.recv_timeout(Duration::from_secs(5)) {
            if which == "out" { out = s } else { err = s }
        }
    }
    let out = out.trim().to_string();
    if out.is_empty() {
        let e = err.trim();
        let e = e.lines().next().unwrap_or("").chars().take(300).collect::<String>();
        return Err(format!("Outlook:Script:{e}"));
    }
    Ok(out)
}
