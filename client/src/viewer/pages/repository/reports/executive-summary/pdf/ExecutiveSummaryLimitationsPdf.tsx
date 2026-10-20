import { StyleSheet, Text, View } from '@react-pdf/renderer';
import { pdfStyles } from '../../pdf/pdfStyles';

interface Props {
  excludedSessionCount: number;
  excludedModels: string[];
}

const styles = StyleSheet.create({
  bulletRow: { flexDirection: 'row', marginBottom: 4 },
  bulletDot: { width: 10, fontSize: 9, color: '#71717a' },
  bulletText: { flex: 1, fontSize: 9, color: '#52525b' },
  divider: {
    borderBottomWidth: 1,
    borderBottomColor: '#e4e4e7',
    marginTop: 4,
    marginBottom: 8,
  },
  noticeBold: { fontWeight: 700, color: '#18181b' },
});

// PDF counterpart of ExecutiveSummaryLimitations.tsx — same 5 fixed bullets
// plus the conditional excluded-sessions notice, rendered inside the
// shared pdfStyles.limitationsPanel muted footnote panel.
export function ExecutiveSummaryLimitationsPdf({
  excludedSessionCount,
  excludedModels,
}: Props) {
  return (
    <View style={pdfStyles.section}>
      <Text style={pdfStyles.sectionTitle}>Data Source &amp; Limitations</Text>
      <Text style={pdfStyles.sectionSubtitle}>
        How these figures were produced, and what they do not include
      </Text>
      <View style={pdfStyles.limitationsPanel}>
        <View style={styles.bulletRow}>
          <Text style={styles.bulletDot}>•</Text>
          <Text style={styles.bulletText}>
            Figures come from Claude Code telemetry uploaded to the Artisyn Log
            Hub server — not from Anthropic billing APIs.
          </Text>
        </View>
        <View style={styles.bulletRow}>
          <Text style={styles.bulletDot}>•</Text>
          <Text style={styles.bulletText}>
            Scope is a single repository; cross-repository totals are not part
            of this report.
          </Text>
        </View>
        <View style={styles.bulletRow}>
          <Text style={styles.bulletDot}>•</Text>
          <Text style={styles.bulletText}>
            Sessions worked offline, or never uploaded, are not captured.
          </Text>
        </View>
        <View style={styles.bulletRow}>
          <Text style={styles.bulletDot}>•</Text>
          <Text style={styles.bulletText}>
            Cost is calculated with current model pricing (rates effective on or
            before today), not the rate in effect when the session ran —
            historical figures move when pricing changes.
          </Text>
        </View>
        <View style={styles.bulletRow}>
          <Text style={styles.bulletDot}>•</Text>
          <Text style={styles.bulletText}>
            Model mix attributes a session&rsquo;s whole cost to the first model
            observed in that session.
          </Text>
        </View>

        {excludedSessionCount > 0 && (
          <>
            <View style={styles.divider} />
            <View style={styles.bulletRow}>
              <Text style={styles.bulletDot}>•</Text>
              <Text style={styles.bulletText}>
                <Text style={styles.noticeBold}>
                  {excludedSessionCount} sessions excluded from cost
                </Text>{' '}
                (no pricing for model {excludedModels.join(', ')}). Total AI
                Cost understates spend by that much.
              </Text>
            </View>
          </>
        )}
      </View>
    </View>
  );
}
