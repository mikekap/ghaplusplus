use chrono::{DateTime, Utc};
use js_sys::Array;
use js_sys::Date;
use serde::Serialize;
use tracing::error;
use tracing::instrument::WithSubscriber;
use tracing::warn;
use tracing_subscriber::prelude::*;
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;

#[wasm_bindgen]
pub struct LogParser {
    pending: Vec<u8>,
    discard_first_line: bool,
}

#[derive(Debug)]
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

#[derive(Serialize, Debug)]
pub enum LogElement {
    Line(JSDateTime, String),
    Group(JSDateTime, String, Vec<LogElement>),
}

#[wasm_bindgen]
impl LogParser {
    #[wasm_bindgen(constructor)]
    pub fn new(discard_first_line: bool) -> Self {
        Self {
            pending: Vec::new(),
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

impl LogParser {
    fn push_lines(&mut self, chunk: &[u8]) -> Result<Vec<LogElement>, String> {
        self.pending.extend_from_slice(chunk);

        let Some(last_newline) = self.pending.iter().rposition(|byte| *byte == b'\n') else {
            return Ok(Vec::new());
        };

        let complete = self.pending.drain(..=last_newline).collect::<Vec<_>>();
        self.convert_lines(&complete, false)
    }

    fn finish_lines(&mut self) -> Result<Vec<LogElement>, String> {
        let remaining = std::mem::take(&mut self.pending);
        self.convert_lines(&remaining, true)
    }

    fn convert_lines(
        &mut self,
        bytes: &[u8],
        include_trailing_line: bool,
    ) -> Result<Vec<LogElement>, String> {
        if bytes.is_empty() {
            return Ok(Vec::new());
        }

        let mut output = Vec::new();
        let mut lines = bytes.split(|byte| *byte == b'\n').peekable();

        while let Some(raw_line) = lines.next() {
            if raw_line.is_empty() && lines.peek().is_none() && !include_trailing_line {
                break;
            }

            if self.discard_first_line {
                self.discard_first_line = false;
                continue;
            }

            let raw_line = raw_line.strip_suffix(b"\r").unwrap_or(raw_line);
            let text = String::from_utf8_lossy(raw_line);
            let sample_date = "2026-05-17T06:15:57.6343206Z";
            let (raw_date, raw_text) = text
                .split_at_checked(sample_date.len())
                .unwrap_or(("", &text));

            let (date, raw_text) = chrono::DateTime::parse_from_rfc3339(raw_date)
                .map(|x| (x.with_timezone(&Utc), &raw_text[1..]))
                .unwrap_or_else(|err| {
                    warn!("Failed to parse {raw_date} as date: {err:?}");
                    (Utc::now(), &text)
                });

            let html = ansi_to_html::convert(&raw_text).unwrap_or_else(|err| {
                warn!("Failed to convert log line to html; using raw line: {raw_text}, {err:?}");
                html_escape::encode_text(raw_text).to_string()
            });
            let element = LogElement::Line(date.into(), html);
            output.push(element);
        }

        Ok(output)
    }
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
        assert_matches!(lines.as_slice(), [LogElement::Line(_, s)] if s == "hello");

        let lines = parser.finish_lines().unwrap();
        assert_matches!(lines.as_slice(), [LogElement::Line(_, s)] if s == "world");
    }

    #[test]
    fn discards_a_partial_range_line() {
        let mut parser = LogParser::new(true);
        let lines = parser.push_lines(b"partial\n\x1b[31mred\x1b[0m\n").unwrap();
        assert_matches!(lines.as_slice(), [LogElement::Line(_, s)] if s.contains("red"));
        assert!(parser.finish_lines().unwrap().is_empty());
    }
}
