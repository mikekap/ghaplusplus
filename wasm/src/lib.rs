use chrono::{DateTime, Utc};
use js_sys::Array;
#[cfg(target_arch = "wasm32")]
use reqwest::header::{CONTENT_LENGTH, CONTENT_RANGE, RANGE};
use serde::Serialize;
use std::fmt::Write;
use tracing::error;
use tracing::warn;
use tracing_subscriber::prelude::*;
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;

#[wasm_bindgen]
pub struct LogParser {
    pending: Vec<u8>,
    pending_offset: u64,
    discard_first_line: bool,
}

#[wasm_bindgen]
pub struct LogSession {
    #[cfg(target_arch = "wasm32")]
    log_url: String,
    #[cfg(target_arch = "wasm32")]
    fetched: Option<FetchedLogData>,
}

#[derive(Clone, Debug)]
pub struct JSDateTime {
    pub dt: DateTime<Utc>,
}

impl Serialize for JSDateTime {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_i64(self.dt.timestamp_millis())
    }
}

impl Into<DateTime<Utc>> for JSDateTime {
    fn into(self) -> DateTime<Utc> {
        self.dt
    }
}

impl From<DateTime<Utc>> for JSDateTime {
    fn from(value: DateTime<Utc>) -> Self {
        JSDateTime { dt: value }
    }
}

#[derive(Clone, Serialize, Debug)]
pub enum LogElement {
    Line(JSDateTime, String, u64),
    Group(JSDateTime, String, Vec<LogElement>),
}

#[cfg(target_arch = "wasm32")]
#[derive(Serialize)]
struct FetchedLog {
    chunks: Vec<RenderedChunk>,
    length: u64,
    complete: bool,
    #[serde(rename = "wrapColumns")]
    wrap_columns: u32,
}

#[derive(Serialize)]
struct RenderedChunk {
    html: String,
    rows: usize,
    #[serde(rename = "estimatedHeight")]
    estimated_height: usize,
}

#[cfg(target_arch = "wasm32")]
struct FetchedLogData {
    elements: Vec<LogElement>,
    start: u64,
    length: u64,
    complete: bool,
}

#[cfg(target_arch = "wasm32")]
struct ContentRange {
    start: u64,
    length: u64,
    complete: bool,
}

#[cfg(target_arch = "wasm32")]
const LOG_RANGE_BYTES: u64 = 2 * 1024 * 1024;

#[wasm_bindgen]
impl LogParser {
    #[wasm_bindgen(constructor)]
    pub fn new(discard_first_line: bool) -> Self {
        Self::with_offset(discard_first_line, 0)
    }

    fn with_offset(discard_first_line: bool, pending_offset: u64) -> Self {
        Self {
            pending: Vec::new(),
            pending_offset,
            discard_first_line,
        }
    }

    /// Accepts the next chunk from a browser ReadableStream and returns the
    /// completed lines in that chunk as escaped, ANSI-formatted HTML.
    pub fn push(&mut self, chunk: &[u8]) -> Result<Array, JsValue> {
        self.push_lines(chunk)
            .map_err(|x: String| JsValue::from_str(&x))
            .and_then(lines_to_jsvalue)
    }

    /// Flushes the final unterminated line after the stream reaches EOF.
    pub fn finish(&mut self) -> Result<Array, JsValue> {
        self.finish_lines()
            .map_err(|x: String| JsValue::from_str(&x))
            .and_then(lines_to_jsvalue)
    }
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
impl LogSession {
    #[wasm_bindgen(constructor)]
    pub fn new(log_url: String) -> Self {
        Self {
            log_url,
            fetched: None,
        }
    }

    pub async fn fetch(&mut self, wrap_columns: u32) -> Result<JsValue, JsValue> {
        // Azure's Actions log endpoint does not reliably honor suffix ranges.
        // Probe from byte zero for the total length, then fetch an explicit tail.
        let (front_range, front_bytes) = fetch_log_range(
            &self.log_url,
            format!("bytes=0-{}", LOG_RANGE_BYTES - 1),
        )
        .await?;
        let length = if front_range.length == 0 {
            front_bytes.len() as u64
        } else {
            front_range.length
        };

        let (range, bytes) = if front_range.complete {
            (front_range, front_bytes)
        } else {
            if length == 0 {
                return Err(JsValue::from_str("Log range response did not provide a total length"));
            }
            fetch_log_range(
                &self.log_url,
                format!("bytes={}-{}", length.saturating_sub(LOG_RANGE_BYTES), length - 1),
            )
            .await?
        };
        let mut parser = LogParser::with_offset(range.start > 0, range.start);
        let mut elements = parser
            .push_lines(&bytes)
            .map_err(|error| JsValue::from_str(&error))?;
        elements.extend(parser.finish_lines().map_err(|error| JsValue::from_str(&error))?);
        self.fetched = Some(FetchedLogData {
            elements,
            start: range.start,
            length,
            complete: range.complete,
        });
        self.render(wrap_columns)
    }

    pub async fn fetch_previous(&mut self, wrap_columns: u32) -> Result<JsValue, JsValue> {
        let current_start = self
            .fetched
            .as_ref()
            .ok_or_else(|| JsValue::from_str("Log session has not fetched a range"))?
            .start;
        if current_start == 0 {
            return self.render(wrap_columns);
        }

        let range_end = current_start - 1;
        let range_start = range_end.saturating_sub(LOG_RANGE_BYTES - 1);
        let (range, bytes) = fetch_log_range(&self.log_url, format!("bytes={range_start}-{range_end}")).await?;
        let mut parser = LogParser::with_offset(range.start > 0, range.start);
        // The final bytes continue the partial line discarded from the current
        // range, so do not flush this parser's trailing line.
        let elements = parser
            .push_lines(&bytes)
            .map_err(|error| JsValue::from_str(&error))?;
        let fetched = self.fetched.as_mut().expect("checked above");
        fetched.elements.splice(0..0, elements);
        fetched.start = range.start;
        if range.length != 0 {
            fetched.length = range.length;
        }
        fetched.complete = range.start == 0;
        self.render(wrap_columns)
    }

    pub fn rewrap(&self, wrap_columns: u32) -> Result<JsValue, JsValue> {
        if self.fetched.is_none() {
            return Err(JsValue::from_str("Log session has not fetched a range"));
        }
        self.render(wrap_columns)
    }

    fn render(&self, wrap_columns: u32) -> Result<JsValue, JsValue> {
        let fetched = self.fetched.as_ref().expect("checked by caller");
        serde_wasm_bindgen::to_value(&FetchedLog {
            chunks: render_chunks(&fetched.elements, wrap_columns as usize),
            length: fetched.length,
            complete: fetched.complete,
            wrap_columns,
        })
        .map_err(|error| JsValue::from_str(&format!("Failed to serialize rendered log: {error}")))
    }
}

#[cfg(target_arch = "wasm32")]
async fn fetch_log_range(log_url: &str, range_value: String) -> Result<(ContentRange, Vec<u8>), JsValue> {
    let response = reqwest::Client::new()
        .get(log_url)
        .header(RANGE, range_value)
        .fetch_credentials_include()
        .send()
        .await
        .map_err(request_error)?;

    if !response.status().is_success() {
        return Err(JsValue::from_str(&format!(
            "Log request failed with HTTP {}",
            response.status()
        )));
    }

    let range = content_range(&response)?;
    let bytes = response.bytes().await.map_err(request_error)?.to_vec();
    Ok((range, bytes))
}

#[cfg(target_arch = "wasm32")]
fn content_range(response: &reqwest::Response) -> Result<ContentRange, JsValue> {
    let fallback_length = || {
        response
            .headers()
            .get(CONTENT_LENGTH)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0)
    };

    let Some(value) = response.headers().get(CONTENT_RANGE) else {
        return Ok(ContentRange {
            start: 0,
            length: fallback_length(),
            complete: response.status() == reqwest::StatusCode::OK,
        });
    };
    let value = value
        .to_str()
        .map_err(|error| JsValue::from_str(&format!("Invalid Content-Range header: {error}")))?;
    let Some(range) = value.strip_prefix("bytes ") else {
        return Ok(ContentRange {
            start: 0,
            length: fallback_length(),
            complete: false,
        });
    };
    let Some((range, total)) = range.split_once('/') else {
        return Ok(ContentRange {
            start: 0,
            length: fallback_length(),
            complete: false,
        });
    };
    let Some((start, end)) = range.split_once('-') else {
        return Ok(ContentRange {
            start: 0,
            length: fallback_length(),
            complete: false,
        });
    };

    let start = start
        .parse::<u64>()
        .map_err(|error| JsValue::from_str(&format!("Invalid range start: {error}")))?;
    let end = end
        .parse::<u64>()
        .map_err(|error| JsValue::from_str(&format!("Invalid range end: {error}")))?;
    let total = total
        .parse::<u64>()
        .map_err(|error| JsValue::from_str(&format!("Invalid range length: {error}")))?;
    Ok(ContentRange {
        start,
        length: total,
        complete: start == 0 && end.checked_add(1) == Some(total),
    })
}

#[cfg(target_arch = "wasm32")]
fn request_error(error: reqwest::Error) -> JsValue {
    JsValue::from_str(&format!("Log request failed: {error}"))
}

impl LogParser {
    fn fallback_date() -> DateTime<Utc> {
        DateTime::from_timestamp_millis(0).expect("unix epoch is a valid timestamp")
    }

    fn parse_line(text: &str, byte_offset: u64) -> LogElement {
        let text = text.strip_prefix('\u{feff}').unwrap_or(text);
        let (date, raw_text) = text
            .split_once(char::is_whitespace)
            .and_then(|(raw_date, raw_text)| {
                chrono::DateTime::parse_from_rfc3339(raw_date)
                    .ok()
                    // split_once consumed the single timestamp separator.
                    // Everything after it is log content, including spaces.
                    .map(|date| (date.with_timezone(&Utc), raw_text))
            })
            // Non-timestamped lines are valid GitHub Actions output. Do not
            // log a warning per line: a 2MB range can otherwise flood the
            // console and starve the page.
            .unwrap_or_else(|| (Self::fallback_date(), text));

        let html = ansi_to_html::convert(&raw_text).unwrap_or_else(|err| {
            warn!("Failed to convert log line to html; using raw line: {raw_text}, {err:?}");
            html_escape::encode_text(raw_text).to_string()
        });
        LogElement::Line(date.into(), html, byte_offset)
    }

    fn push_lines(&mut self, chunk: &[u8]) -> Result<Vec<LogElement>, String> {
        self.pending.extend_from_slice(chunk);

        let Some(last_newline) = self.pending.iter().rposition(|byte| *byte == b'\n') else {
            return Ok(Vec::new());
        };

        let complete = self.pending.drain(..=last_newline).collect::<Vec<_>>();
        let offset = self.pending_offset;
        self.pending_offset += complete.len() as u64;
        self.convert_lines(&complete, false, offset)
    }

    fn finish_lines(&mut self) -> Result<Vec<LogElement>, String> {
        let remaining = std::mem::take(&mut self.pending);
        let offset = self.pending_offset;
        self.pending_offset += remaining.len() as u64;
        self.convert_lines(&remaining, true, offset)
    }

    fn convert_lines(
        &mut self,
        bytes: &[u8],
        include_trailing_line: bool,
        byte_offset: u64,
    ) -> Result<Vec<LogElement>, String> {
        if bytes.is_empty() {
            return Ok(Vec::new());
        }

        let mut output = Vec::new();
        let mut consumed = 0_u64;

        for line in bytes.split_inclusive(|byte| *byte == b'\n') {
            if !line.ends_with(b"\n") && !include_trailing_line {
                break;
            }

            let line_offset = byte_offset + consumed;
            consumed += line.len() as u64;
            let raw_line = line.strip_suffix(b"\n").unwrap_or(line);

            if self.discard_first_line {
                self.discard_first_line = false;
                continue;
            }

            let raw_line = raw_line.strip_suffix(b"\r").unwrap_or(raw_line);
            let text = String::from_utf8_lossy(raw_line);
            let element = Self::parse_line(&text, line_offset);

            output.push(element);
        }

        Ok(output)
    }
}

const LOG_CHUNK_ROWS: usize = 200;

fn render_chunks(elements: &[LogElement], wrap_columns: usize) -> Vec<RenderedChunk> {
    let mut chunks = Vec::new();
    let mut html = String::new();
    let mut rows = 0;
    let mut estimated_height = 0;
    let wrap_columns = wrap_columns.max(40);

    let mut append = |timestamp: &JSDateTime, line_html: &str, byte_offset: u64| {
        let visible_columns = html_visible_columns(line_html);
        let estimated_visual_rows = visible_columns.div_ceil(wrap_columns).max(1);
        let wraps = estimated_visual_rows > 1;
        let timestamp = if timestamp.dt.timestamp_millis() != 0 {
            timestamp.dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        } else {
            String::new()
        };
        let wrap_class = if wraps { " gha-log-line--wrap" } else { "" };
        let _ = write!(
            html,
            "<div class=\"gha-log-line{wrap_class}\" data-offset=\"B{byte_offset}\"><span class=\"gha-log-timestamp\">{timestamp}</span><span class=\"gha-log-content\">{line_html}</span></div>"
        );
        rows += 1;
        estimated_height += estimated_visual_rows * 18;
        if rows == LOG_CHUNK_ROWS {
            chunks.push(RenderedChunk {
                html: std::mem::take(&mut html),
                rows,
                estimated_height,
            });
            rows = 0;
            estimated_height = 0;
        }
    };

    fn visit(
        elements: &[LogElement],
        append: &mut impl FnMut(&JSDateTime, &str, u64),
    ) {
        for element in elements {
            match element {
                LogElement::Line(timestamp, html, byte_offset) => append(timestamp, html, *byte_offset),
                LogElement::Group(_, _, children) => visit(children, append),
            }
        }
    }

    visit(elements, &mut append);
    if rows != 0 {
        chunks.push(RenderedChunk {
            html,
            rows,
            estimated_height,
        });
    }
    chunks
}

/// Counts visible text columns in the controlled inline HTML emitted by
/// ansi-to-html. Tags are zero-width and escaped entities occupy one column.
fn html_visible_columns(html: &str) -> usize {
    let mut columns = 0;
    let mut cursor = 0;

    while cursor < html.len() {
        let remainder = &html[cursor..];
        if remainder.starts_with('<') {
            let Some(end) = remainder.find('>') else {
                break;
            };
            let tag = &remainder[..=end];
            cursor += tag.len();
            continue;
        }

        let unit = if remainder.starts_with('&') {
            if let Some(end) = remainder.find(';') {
                &remainder[..=end]
            } else {
                &remainder[..1]
            }
        } else {
            let character = remainder.chars().next().expect("cursor is in bounds");
            &remainder[..character.len_utf8()]
        };
        columns += 1;
        cursor += unit.len();
    }
    columns
}

fn lines_to_jsvalue<T>(lines: Vec<T>) -> Result<Array, JsValue>
where
    T: Serialize,
{
    Ok(serde_wasm_bindgen::to_value(&lines)
        .unwrap_or_else(|err| {
            error!("Failed to convert to JS: {err:?}");
            Array::new().into()
        })
        .dyn_into::<Array>()
        .unwrap())
}

#[wasm_bindgen(start)]
pub fn init() {
    std::panic::set_hook(Box::new(console_error_panic_hook::hook));

    tracing_subscriber::registry()
        .with(
            tracing_subscriber::fmt::layer()
                .without_time()
                .with_writer(tracing_subscriber_wasm::MakeConsoleWriter::default()),
        )
        .init();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::assert_matches;

    #[test]
    fn buffers_partial_lines() {
        let mut parser = LogParser::new(false);
        assert!(parser.push_lines(b"hel").unwrap().is_empty());

        let lines = parser.push_lines(b"lo\nworld").unwrap();
        assert_matches!(lines.as_slice(), [LogElement::Line(_, s, 0)] if s == "hello");

        let lines = parser.finish_lines().unwrap();
        assert_matches!(lines.as_slice(), [LogElement::Line(_, s, 6)] if s == "world");
    }

    #[test]
    fn discards_a_partial_range_line() {
        let mut parser = LogParser::with_offset(true, 100);
        let lines = parser.push_lines(b"partial\n\x1b[31mred\x1b[0m\n").unwrap();
        assert_matches!(lines.as_slice(), [LogElement::Line(_, s, 108)] if s.contains("red"));
        assert!(parser.finish_lines().unwrap().is_empty());
    }

    #[test]
    fn parses_bom_prefixed_timestamp() {
        let LogElement::Line(ts, text, byte_offset) =
            LogParser::parse_line("\u{feff}2026-05-17T06:16:09.07823Z   hello", 42) else {
                panic!("Nope");
            };
        assert_eq!(Into::<DateTime<Utc>>::into(ts).timestamp_millis(), 1_778_998_569_078);
        assert_eq!(text, "  hello");
        assert_eq!(byte_offset, 42);
    }

    #[test]
    fn keeps_non_timestamped_output_without_logging() {
        let LogElement::Line(timestamp, text, byte_offset) =
            LogParser::parse_line("plain output", 7) else {
                panic!("Nope");
            };
        assert_eq!(Into::<DateTime<Utc>>::into(timestamp).timestamp_millis(), 0);
        assert_eq!(text, "plain output");
        assert_eq!(byte_offset, 7);
    }

    #[test]
    fn counts_visible_html_columns() {
        assert_eq!(
            html_visible_columns("<span style='color:var(--red,#a00)'>&lt;abc&gt;</span>"),
            5,
        );
    }

    #[test]
    fn marks_long_lines_for_browser_wrapping() {
        let line = LogElement::Line(
            JSDateTime::from(DateTime::from_timestamp_millis(1).unwrap()),
            "a".repeat(41),
            99,
        );
        let chunks = render_chunks(&[line], 40);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].rows, 1);
        assert_eq!(chunks[0].estimated_height, 36);
        assert!(chunks[0].html.contains("data-offset=\"B99\""));
        assert!(chunks[0].html.contains("gha-log-line--wrap"));
    }
}
