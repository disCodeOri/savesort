/// Which vault paths the sync engine ignores. Deliberately data, not
/// hardcoded logic (spec: "make the exclusion strategy configurable and
/// document it") — the defaults live here, but a user's settings can add to
/// or replace them.
#[derive(Debug, Clone)]
pub struct ExcludeRules {
    /// A path is excluded if any of its components exactly matches one of
    /// these (case-insensitive), e.g. ".obsidian" excludes
    /// ".obsidian/workspace.json" at any depth.
    pub excluded_dir_names: Vec<String>,
    /// A path is excluded if its file name ends with one of these
    /// (case-insensitive), e.g. editor scratch files.
    pub excluded_name_suffixes: Vec<String>,
}

impl Default for ExcludeRules {
    fn default() -> Self {
        Self {
            excluded_dir_names: vec![
                ".obsidian".into(),
                ".trash".into(),
                ".git".into(),
                "node_modules".into(),
            ],
            excluded_name_suffixes: vec![".tmp".into(), ".swp".into(), "~".into()],
        }
    }
}

impl ExcludeRules {
    /// `relative_path` uses forward slashes regardless of platform, matching
    /// the wire format the server expects.
    pub fn is_excluded(&self, relative_path: &str) -> bool {
        let components: Vec<&str> = relative_path.split('/').collect();
        if components
            .iter()
            .take(components.len().saturating_sub(1))
            .any(|component| {
                self.excluded_dir_names
                    .iter()
                    .any(|excluded| component.eq_ignore_ascii_case(excluded))
            })
        {
            return true;
        }

        let Some(name) = components.last() else {
            return false;
        };
        self.excluded_name_suffixes
            .iter()
            .any(|suffix| name.to_ascii_lowercase().ends_with(&suffix.to_ascii_lowercase()))
    }

    pub fn is_markdown(relative_path: &str) -> bool {
        relative_path.to_ascii_lowercase().ends_with(".md")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn excludes_obsidian_and_trash_at_any_depth() {
        let rules = ExcludeRules::default();
        assert!(rules.is_excluded(".obsidian/workspace.json"));
        assert!(rules.is_excluded(".trash/Deleted.md"));
        assert!(rules.is_excluded("Sub/.obsidian/plugins/x.json"));
    }

    #[test]
    fn does_not_exclude_a_folder_that_merely_contains_the_word() {
        // ".obsidian-notes" is a real, unrelated folder name; only an exact
        // path component match should exclude.
        let rules = ExcludeRules::default();
        assert!(!rules.is_excluded("Obsidian Notes/Idea.md"));
    }

    #[test]
    fn excludes_editor_scratch_files_by_suffix() {
        let rules = ExcludeRules::default();
        assert!(rules.is_excluded("Notes/Draft.md.tmp"));
        assert!(rules.is_excluded("Notes/.Draft.md.swp"));
        assert!(rules.is_excluded("Notes/Draft.md~"));
    }

    #[test]
    fn keeps_ordinary_markdown_files() {
        let rules = ExcludeRules::default();
        assert!(!rules.is_excluded("Projects/Kickoff.md"));
        assert!(!rules.is_excluded("Templates/Daily Note Template.md"));
    }

    #[test]
    fn is_markdown_is_case_insensitive_on_the_extension() {
        assert!(ExcludeRules::is_markdown("Note.md"));
        assert!(ExcludeRules::is_markdown("Note.MD"));
        assert!(!ExcludeRules::is_markdown("image.png"));
    }
}
