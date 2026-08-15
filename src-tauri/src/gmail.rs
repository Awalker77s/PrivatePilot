// Gmail over IMAP with an app password — no developer registration, no
// OAuth screens: the person generates an app password in their Google
// account and pastes it once. Reads never mark mail as read (BODY.PEEK);
// the only write is a DRAFT appended to [Gmail]/Drafts, which the person
// sends from Gmail. Never a SEND. The password lives DPAPI-sealed and is
// unsealed here, used for the login, and dropped — it never crosses IPC.
use crate::secrets;
use mailparse::{parse_headers, parse_mail, MailHeaderMap, ParsedMail};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

const HOST: &str = "imap.gmail.com";
const PORT: u16 = 993;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const IO_TIMEOUT: Duration = Duration::from_secs(45);
const BODY_CAP: usize = 6000;
pub const SECRET_NAME: &str = "gmail.app_password";

#[derive(Deserialize, Default)]
struct Args {
    since_hours: Option<f64>,
    unread_only: Option<bool>,
    from: Option<String>,
    limit: Option<usize>,
    query: Option<String>,
    uid: Option<u32>,
    reply_to: Option<u32>,
    to: Option<String>,
    subject: Option<String>,
    body: Option<String>,
}

#[derive(Serialize)]
struct Row {
    id: u32,
    when: String,
    from: String,
    address: String,
    subject: String,
    unread: bool,
    size: u32,
}

type Session = imap::Session<native_tls::TlsStream<TcpStream>>;

fn connect(account: &str, password: &str) -> Result<Session, String> {
    let addr = (HOST, PORT)
        .to_socket_addrs()
        .map_err(|e| format!("Gmail:Dns:{e}"))?
        .next()
        .ok_or_else(|| "Gmail:Dns:no address".to_string())?;
    let tcp = TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT).map_err(|e| format!("Gmail:Connect:{e}"))?;
    tcp.set_read_timeout(Some(IO_TIMEOUT)).ok();
    tcp.set_write_timeout(Some(IO_TIMEOUT)).ok();
    let tls = native_tls::TlsConnector::new().map_err(|e| format!("Gmail:Tls:{e}"))?;
    let stream = tls.connect(HOST, tcp).map_err(|e| format!("Gmail:Tls:{e}"))?;
    let client = imap::Client::new(stream);
    // Gmail's greeting is read by Client::new's caller through the first
    // command; login handles it.
    match client.login(account, password) {
        Ok(session) => Ok(session),
        Err((e, _)) => Err(format!("Gmail:Login:{e}")),
    }
}

fn header_of(bytes: &[u8], name: &str) -> String {
    parse_headers(bytes)
        .map(|(h, _)| h.get_first_value(name).unwrap_or_default())
        .unwrap_or_default()
}

fn split_address(from: &str) -> (String, String) {
    // "Jane Doe <jane@x.com>" → ("Jane Doe", "jane@x.com"); bare address → both.
    if let Some(start) = from.find('<') {
        if let Some(end) = from[start..].find('>') {
            let addr = from[start + 1..start + end].trim().to_string();
            let name = from[..start].trim().trim_matches('"').to_string();
            return (if name.is_empty() { addr.clone() } else { name }, addr);
        }
    }
    (from.trim().to_string(), from.trim().to_string())
}

fn imap_date(days_ago: f64) -> String {
    let secs = (days_ago * 86400.0) as i64;
    let t = chrono::Utc::now() - chrono::Duration::seconds(secs);
    t.format("%d-%b-%Y").to_string()
}

fn rows_for(session: &mut Session, uids: &[u32]) -> Result<Vec<Row>, String> {
    if uids.is_empty() {
        return Ok(vec![]);
    }
    let set = uids.iter().map(|u| u.to_string()).collect::<Vec<_>>().join(",");
    let fetches = session
        .uid_fetch(set, "(UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[HEADER])")
        .map_err(|e| format!("Gmail:Fetch:{e}"))?;
    let mut rows = Vec::new();
    for f in fetches.iter() {
        let hdr = f.header().unwrap_or(&[]);
        let (from, address) = split_address(&header_of(hdr, "From"));
        let when = f
            .internal_date()
            .map(|d| d.with_timezone(&chrono::Local).format("%Y-%m-%dT%H:%M").to_string())
            .unwrap_or_default();
        rows.push(Row {
            id: f.uid.unwrap_or(0),
            when,
            from,
            address,
            subject: header_of(hdr, "Subject"),
            unread: !f.flags().iter().any(|fl| matches!(fl, imap::types::Flag::Seen)),
            size: f.size.unwrap_or(0),
        });
    }
    // Newest first.
    rows.sort_by(|a, b| b.when.cmp(&a.when));
    Ok(rows)
}

fn text_of(mail: &ParsedMail) -> String {
    // Prefer text/plain; fall back to a de-tagged text/html.
    fn walk(m: &ParsedMail, plain: &mut Option<String>, html: &mut Option<String>) {
        let ct = m.ctype.mimetype.to_lowercase();
        if m.subparts.is_empty() {
            if ct == "text/plain" && plain.is_none() {
                *plain = m.get_body().ok();
            } else if ct == "text/html" && html.is_none() {
                *html = m.get_body().ok();
            }
        }
        for p in &m.subparts {
            walk(p, plain, html);
        }
    }
    let (mut plain, mut html) = (None, None);
    walk(mail, &mut plain, &mut html);
    if let Some(p) = plain {
        return p;
    }
    if let Some(h) = html {
        let no_tags = regex_lite_strip(&h);
        return no_tags;
    }
    String::new()
}

// A small tag stripper (no HTML crate on the Rust side): drop <script>/<style>
// blocks, then every tag, then collapse whitespace.
fn regex_lite_strip(html: &str) -> String {
    let mut s = html.to_string();
    for tag in ["script", "style"] {
        loop {
            let lower = s.to_lowercase();
            let Some(start) = lower.find(&format!("<{tag}")) else { break };
            let Some(end_rel) = lower[start..].find(&format!("</{tag}>")) else { break };
            s.replace_range(start..start + end_rel + tag.len() + 3, " ");
        }
    }
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for ch in s.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => {
                in_tag = false;
                out.push(' ');
            }
            c if !in_tag => out.push(c),
            _ => {}
        }
    }
    let out = out
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'");
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn op_recent(session: &mut Session, a: &Args) -> Result<serde_json::Value, String> {
    session.examine("INBOX").map_err(|e| format!("Gmail:Select:{e}"))?;
    let hours = a.since_hours.unwrap_or(24.0).clamp(1.0, 720.0);
    // IMAP SINCE is day-granular; we over-fetch by a day and trim in code.
    let mut q = format!("SINCE {}", imap_date(hours / 24.0 + 1.0));
    if a.unread_only.unwrap_or(false) {
        q.push_str(" UNSEEN");
    }
    if let Some(from) = a.from.as_deref().filter(|s| !s.trim().is_empty()) {
        q.push_str(&format!(" FROM \"{}\"", from.replace('"', "")));
    }
    let uids = session.uid_search(&q).map_err(|e| format!("Gmail:Search:{e}"))?;
    let mut list: Vec<u32> = uids.into_iter().collect();
    list.sort_unstable_by(|x, y| y.cmp(x)); // newest UIDs first
    let limit = a.limit.unwrap_or(15).clamp(1, 25);
    let cutoff = chrono::Local::now() - chrono::Duration::seconds((hours * 3600.0) as i64);
    let cutoff_s = cutoff.format("%Y-%m-%dT%H:%M").to_string();
    // Fetch a little more than the limit so the hour trim still fills it.
    let take: Vec<u32> = list.into_iter().take(limit * 2).collect();
    let rows: Vec<Row> = rows_for(session, &take)?
        .into_iter()
        .filter(|r| r.when >= cutoff_s)
        .take(limit)
        .collect();
    Ok(json!({ "rows": rows }))
}

fn op_search(session: &mut Session, a: &Args) -> Result<serde_json::Value, String> {
    session.examine("[Gmail]/All Mail").or_else(|_| session.examine("INBOX")).map_err(|e| format!("Gmail:Select:{e}"))?;
    let query = a.query.clone().unwrap_or_default();
    let clean = query.replace('"', "").replace('\\', "");
    // Gmail's own search syntax over IMAP.
    let uids = session
        .uid_search(format!("X-GM-RAW \"{clean}\""))
        .map_err(|e| format!("Gmail:Search:{e}"))?;
    let mut list: Vec<u32> = uids.into_iter().collect();
    list.sort_unstable_by(|x, y| y.cmp(x));
    let limit = a.limit.unwrap_or(15).clamp(1, 25);
    let take: Vec<u32> = list.into_iter().take(limit).collect();
    let rows = rows_for(session, &take)?;
    Ok(json!({ "rows": rows }))
}

fn op_read(session: &mut Session, a: &Args) -> Result<serde_json::Value, String> {
    let uid = a.uid.ok_or_else(|| "Gmail:Args:uid".to_string())?;
    // Search-listed ids come from All Mail; recent from INBOX. Try both.
    let mut got: Option<Vec<u8>> = None;
    for mbox in ["INBOX", "[Gmail]/All Mail"] {
        if session.examine(mbox).is_err() {
            continue;
        }
        let f = session
            .uid_fetch(uid.to_string(), "(UID BODY.PEEK[])")
            .map_err(|e| format!("Gmail:Fetch:{e}"))?;
        if let Some(m) = f.iter().next() {
            if let Some(b) = m.body() {
                got = Some(b.to_vec());
                break;
            }
        }
    }
    let raw = got.ok_or_else(|| "Gmail:NoSuchMessage".to_string())?;
    let mail = parse_mail(&raw).map_err(|e| format!("Gmail:Parse:{e}"))?;
    let h = &mail.headers;
    let (from, address) = split_address(&h.get_first_value("From").unwrap_or_default());
    let mut body = text_of(&mail);
    if body.chars().count() > BODY_CAP {
        body = body.chars().take(BODY_CAP).collect::<String>() + "\n[… trimmed]";
    }
    let attachments: Vec<String> = {
        let mut names = Vec::new();
        fn walk(m: &ParsedMail, names: &mut Vec<String>) {
            if let Some(n) = m.get_content_disposition().params.get("filename") {
                names.push(n.clone());
            }
            for p in &m.subparts {
                walk(p, names);
            }
        }
        walk(&mail, &mut names);
        names
    };
    Ok(json!({
        "id": uid,
        "from": from,
        "address": address,
        "to": h.get_first_value("To").unwrap_or_default(),
        "cc": h.get_first_value("Cc").unwrap_or_default(),
        "date": h.get_first_value("Date").unwrap_or_default(),
        "subject": h.get_first_value("Subject").unwrap_or_default(),
        "message_id": h.get_first_value("Message-ID").unwrap_or_default(),
        "attachments": attachments,
        "body": body,
    }))
}

fn op_draft(session: &mut Session, account: &str, a: &Args) -> Result<serde_json::Value, String> {
    let body = a.body.clone().unwrap_or_default();
    let (to, subject, in_reply_to) = if let Some(uid) = a.reply_to {
        // Reply: address the original sender, thread it, quote nothing.
        let mut meta: Option<(String, String, String)> = None;
        for mbox in ["INBOX", "[Gmail]/All Mail"] {
            if session.examine(mbox).is_err() {
                continue;
            }
            let f = session
                .uid_fetch(uid.to_string(), "(UID BODY.PEEK[HEADER])")
                .map_err(|e| format!("Gmail:Fetch:{e}"))?;
            if let Some(m) = f.iter().next() {
                if let Some(hdr) = m.header() {
                    let (_, addr) = split_address(&header_of(hdr, "From"));
                    let subj = header_of(hdr, "Subject");
                    let mid = header_of(hdr, "Message-ID");
                    meta = Some((addr, subj, mid));
                    break;
                }
            }
        }
        let (addr, subj, mid) = meta.ok_or_else(|| "Gmail:NoSuchMessage".to_string())?;
        let re = if subj.to_lowercase().starts_with("re:") { subj } else { format!("Re: {subj}") };
        (addr, re, mid)
    } else {
        (
            a.to.clone().unwrap_or_default(),
            a.subject.clone().unwrap_or_default(),
            String::new(),
        )
    };
    let date = chrono::Local::now().to_rfc2822();
    let mut msg = String::new();
    msg.push_str(&format!("From: {account}\r\n"));
    msg.push_str(&format!("To: {to}\r\n"));
    msg.push_str(&format!("Subject: {}\r\n", subject.replace(['\r', '\n'], " ")));
    msg.push_str(&format!("Date: {date}\r\n"));
    if !in_reply_to.is_empty() {
        msg.push_str(&format!("In-Reply-To: {in_reply_to}\r\nReferences: {in_reply_to}\r\n"));
    }
    msg.push_str("MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\nX-Mailer: Private Pilot (draft — never sent by the app)\r\n\r\n");
    msg.push_str(&body.replace("\r\n", "\n").replace('\n', "\r\n"));
    session
        .append_with_flags("[Gmail]/Drafts", msg.as_bytes(), &[imap::types::Flag::Draft])
        .map_err(|e| format!("Gmail:Append:{e}"))?;
    Ok(json!({ "to": to, "subject": subject }))
}

/// One Gmail operation over IMAP. `account` is the address (settings);
/// the app password is unsealed here and never returned.
#[tauri::command(async)]
pub fn gmail_imap(app: tauri::AppHandle, account: String, op: String, args: String) -> Result<String, String> {
    let password = secrets::get(&app, SECRET_NAME)?.ok_or_else(|| "Gmail:NoPassword".to_string())?;
    if account.trim().is_empty() {
        return Err("Gmail:NoAccount".to_string());
    }
    let a: Args = serde_json::from_str(&args).unwrap_or_default();
    let mut session = connect(account.trim(), &password)?;
    drop(password);
    let result = match op.as_str() {
        "status" => Ok(json!({ "ok": true, "account": account.trim() })),
        "recent" => op_recent(&mut session, &a),
        "search" => op_search(&mut session, &a),
        "read" => op_read(&mut session, &a),
        "draft" => op_draft(&mut session, account.trim(), &a),
        other => Err(format!("Gmail:UnknownOp:{other}")),
    };
    let _ = session.logout();
    result.map(|v| v.to_string())
}
