pub fn normalize_paste(value: &str) -> String {
    let normalized = value.replace("\r\n", "\n").replace('\r', "\n");
    if !normalized.contains('\n') {
        return normalized.trim_end().to_string();
    }
    normalized.trim_end_matches('\n').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_crlf_and_trailing_newlines() {
        assert_eq!(normalize_paste("a\r\nb\r\n"), "a\nb");
        assert_eq!(normalize_paste("single"), "single");
        assert_eq!(normalize_paste("a\nb\n\n"), "a\nb");
    }
}
