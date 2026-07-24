#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PastedBlock {
    pub id: usize,
    pub content: String,
    pub placeholder: String,
}

pub fn normalize_paste(value: &str) -> String {
    let normalized = value.replace("\r\n", "\n").replace('\r', "\n");
    if !normalized.contains('\n') {
        return normalized.trim_end().to_string();
    }
    normalized.trim_end_matches('\n').to_string()
}

pub fn should_attach_as_block(content: &str) -> bool {
    content.contains('\n') || content.chars().count() > 100
}

pub fn paste_placeholder(id: usize, line_count: usize) -> String {
    let extra = line_count.saturating_sub(1);
    if extra == 0 {
        format!("[Pasted text #{id}]")
    } else {
        format!("[Pasted text #{id} +{extra} lines]")
    }
}

pub fn expand_paste_placeholders(display: &str, blocks: &[PastedBlock]) -> String {
    let mut result = display.to_string();
    let mut ordered: Vec<&PastedBlock> = blocks.iter().collect();
    ordered.sort_by_key(|block| block.placeholder.len());
    ordered.reverse();
    for block in ordered {
        result = result.replace(&block.placeholder, &block.content);
    }
    result
}

pub fn find_placeholder_at(text: &str, cursor: usize) -> Option<(std::ops::Range<usize>, usize)> {
    let mut search_from = 0usize;
    while let Some(rel) = text[search_from..].find("[Pasted text #") {
        let start = search_from + rel;
        let rest = &text[start..];
        let end = rest.find(']')? + start + 1;
        if cursor >= start && cursor <= end {
            let id = rest
                .strip_prefix("[Pasted text #")?
                .split([' ', ']'])
                .next()?
                .parse()
                .ok()?;
            return Some((start..end, id));
        }
        search_from = end;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeholder_for_multiline_paste() {
        assert_eq!(paste_placeholder(1, 4), "[Pasted text #1 +3 lines]");
        assert_eq!(paste_placeholder(2, 1), "[Pasted text #2]");
    }

    #[test]
    fn expands_placeholders_to_content() {
        let blocks = vec![PastedBlock {
            id: 1,
            content: "line1\nline2\nline3\nline4".into(),
            placeholder: "[Pasted text #1 +3 lines]".into(),
        }];
        assert_eq!(
            expand_paste_placeholders("see [Pasted text #1 +3 lines] please", &blocks),
            "see line1\nline2\nline3\nline4 please"
        );
    }
}
