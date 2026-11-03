import { NumberField, Row, SectionTitle, Segmented, TextField, Toggle } from '@/components/form'
import { normalizePrefix, slugifyTitle } from '@shared/branchName'
import { LANE_PREF_LIMITS, type LanePrefs } from '@shared/models'
import { usePlatform } from '@/platform/Platform'
import { useLanePrefsStore } from '@/stores/lanePrefs'
import { useWorktreesStore } from '@/stores/worktrees'

const MARKER_MODES = [
  { value: 'auto', label: 'Auto' },
  { value: 'manual', label: 'Manual' },
  { value: 'off', label: 'Off' },
] as const satisfies ReadonlyArray<{ value: LanePrefs['markers']; label: string }>

/**
 * What a branch will actually look like: the prefix is normalized (a bare
 * "Phosphor" becomes "phosphor/") before it is ever used, and the cap is shown
 * doing its job on a realistic title rather than described.
 */
function branchExample(prefix: string, maxLength: number) {
  const examplePrefix = normalizePrefix(prefix)
  const slug = slugifyTitle('Fix the composer autogrow jump on paste', maxLength)
  return { examplePrefix, exampleSlug: `${examplePrefix}${slug}` }
}

/**
 * How this device shows lanes and names their branches, for every machine's
 * lanes it starts or lists: the prefix and slug go into a Host lane's branch
 * as into This Mac's. A device section, so it is the same whichever machine
 * Configure chooses, and the browser keeps it too.
 */
export function LanesSection(): React.JSX.Element {
  const { localLanes } = usePlatform()
  const preferWorktree = useWorktreesStore((s) => s.preferWorktree)
  const branchPrefix = useWorktreesStore((s) => s.branchPrefix)
  const lanes = useLanePrefsStore((s) => s.lanes)
  const setLanePrefs = useLanePrefsStore((s) => s.setLanePrefs)

  const { examplePrefix, exampleSlug } = branchExample(branchPrefix, lanes.branchSlugMaxLength)

  return (
    <div>
      <SectionTitle>Lanes</SectionTitle>
      <div className="border-border bg-surface mb-2 rounded-xl border px-4">
        <Row
          title="Lane markers"
          description="The emoji left of each lane. Click a marker or right-click a lane to pick a new one. Auto derives one from the branch name; Manual shows only your choices; Off hides markers and the picker without clearing choices."
        >
          <Segmented
            value={lanes.markers}
            options={MARKER_MODES}
            onChange={(markers) => setLanePrefs({ markers })}
          />
        </Row>
        <Row
          title="PR status on lanes"
          description="Trails each lane with its GitHub PR status — open, checks, review, merged, conflicts. Off leaves the row to its title, timestamp and branch."
        >
          <Toggle on={lanes.prStatus} onChange={(on) => setLanePrefs({ prStatus: on })} />
        </Row>
      </div>

      <SectionTitle small>New lanes</SectionTitle>
      <div className="border-border bg-surface mb-2 rounded-xl border px-4">
        {/* A Host lane always gets its own branch and worktree; only This Mac's can share one. */}
        {localLanes && (
          <Row
            title="Give each chat its own branch"
            description="A new chat on this computer is branched off the latest main into its own worktree. The same switch as the “worktree” checkbox in the branch menu. Host lanes always get their own."
          >
            <Toggle
              on={preferWorktree}
              onChange={(on) => useWorktreesStore.getState().setPreferWorktree(on)}
            />
          </Row>
        )}
        <Row
          title="Branch prefix"
          description={
            examplePrefix
              ? `Branches are named ${examplePrefix}lane-title. Leave empty for no prefix.`
              : 'Branches are named after the lane title, with no prefix.'
          }
        >
          <TextField
            defaultValue={branchPrefix}
            placeholder="phosphor/"
            onCommit={(value) => useWorktreesStore.getState().setBranchPrefix(value)}
          />
        </Row>
        <Row
          title="Branch name length"
          description={`Capped separately from the title: a slug is read in git output and in a path. "${exampleSlug}"`}
        >
          <NumberField
            value={lanes.branchSlugMaxLength}
            min={LANE_PREF_LIMITS.branchSlugMaxLength.min}
            max={LANE_PREF_LIMITS.branchSlugMaxLength.max}
            step={4}
            onChange={(value) => setLanePrefs({ branchSlugMaxLength: value })}
            suffix="chars"
          />
        </Row>
      </div>
    </div>
  )
}
