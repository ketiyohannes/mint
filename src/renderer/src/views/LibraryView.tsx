import type { JSX } from 'react'
import type { ClassBundle } from '@shared/types'
import { useApp } from '../state/app'
import { AddMaterials, SourceList, TrustedDomains, TrustedSources } from '../components/Materials'

export function LibraryView({ bundle }: { bundle: ClassBundle }): JSX.Element {
  const { focusSource } = useApp()
  const yours = bundle.sources.filter((s) => s.origin === 'user').length
  const found = bundle.sources.length - yours
  const rejected = bundle.sourceProposals.filter((p) => p.status === 'rejected')
  return (
    <div className="page">
      <div className="page-inner">
        <div className="grid-2" style={{ alignItems: 'start' }}>
          <div className="stack" style={{ gap: 18 }}>
            <div>
              <h2 className="section-title" style={{ marginTop: 0 }}>
                Sources
              </h2>
              <div className="small muted" style={{ marginBottom: 10 }}>
                {yours} yours · {found} found by mint. Click one to read it.
              </div>
              <SourceList bundle={bundle} allowRemove onOpen={(s) => focusSource(bundle.meta.id, { sourceId: s.id })} />
            </div>
            <div className="card">
              <div className="card-title">Add your materials</div>
              <AddMaterials bundle={bundle} />
            </div>
          </div>
          <div className="stack" style={{ gap: 18 }}>
            <div className="card">
              <div className="card-title">Fill gaps from trusted sources</div>
              <p className="small muted" style={{ marginTop: -6 }}>
                When your materials do not cover something, mint can suggest trusted public sources. Judging a source is a research skill, so you approve each one.
              </p>
              <TrustedSources bundle={bundle} />
            </div>
            <div className="card">
              <div className="card-title">Trusted domains for this class</div>
              <TrustedDomains bundle={bundle} />
            </div>
            {rejected.length > 0 && (
              <div className="card soft small">
                <b>Rejected suggestions:</b> {rejected.map((p) => p.title).join(' · ')}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
