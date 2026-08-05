/**
 * Mapping of conventional commit types to their display sections in the changelog.
 * Types not present in this map will be grouped under the fallback section.
 */
const COMMIT_SECTIONS = {
  feat: '🚀 Features',
  fix: '🐛 Bug Fixes',
  docs: '📚 Documentation',
  build: '📦 Build System',
  chore: '♻️ Chores',
}

const FALLBACK_SECTION = '🔄 Other Changes'

// Define the precise order in which sections should appear in the release notes
const SECTION_ORDER = [...Object.values(COMMIT_SECTIONS), FALLBACK_SECTION]

/** Creates and configures the conventional-changelog preset. */
async function createConfig() {
  const { default: createPreset } =
    await import('conventional-changelog-conventionalcommits')

  const config = await createPreset({
    types: Object.entries(COMMIT_SECTIONS).map(([type, section]) => ({ type, section })),
  })

  // Hook into the writer transform to classify and filter commits dynamically
  config.writer.transform = (commit) => {
    // 1. Exclude 'chore' merge commits
    const isMergeCommit =
      (commit.subject && commit.subject.toLowerCase().startsWith('merge')) ||
      (commit.header && commit.header.toLowerCase().startsWith('merge'))

    if (commit.type === 'chore' && isMergeCommit) {
      return false
    }

    // 2. Classify the commit into one of our predefined sections or the fallback
    const section = COMMIT_SECTIONS[commit.type] ?? FALLBACK_SECTION
    return { ...commit, type: section, shortHash: commit.hash?.slice(0, 7) }
  }

  // groupBy: 'type' groups by commit.type, which we've rewritten above to be the section title.
  // commitGroupsSort dictates the display order of these groups.
  config.writer.commitGroupsSort = (a, b) =>
    SECTION_ORDER.indexOf(a.title) - SECTION_ORDER.indexOf(b.title)

  return config
}

// Export the resolved Promise of the config so conventional-changelog can consume it
export default createConfig()
