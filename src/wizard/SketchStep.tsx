import { useState } from 'react'
import { PoseEditor } from '../ui/PoseEditor'
import type { SetupApi } from './types'

export function SketchStep({ api }: { api: SetupApi }) {
  const [activeCurve, setActiveCurve] = useState(0)
  return (
    <div className="wiz-stack">
      <section className="wiz-card wiz-card--preview">
        <PoseEditor
          sketch
          setup={api.setup}
          edit={api.update}
          onUndo={api.undo}
          onRedo={api.redo}
          canUndo={api.canUndo}
          canRedo={api.canRedo}
          activeCurve={activeCurve}
          onActiveCurve={setActiveCurve}
        />
      </section>
      <p className="wiz-note">
        Pick a curve, then tap the picture to add guide points in order. Skip this step if the default route is fine.
      </p>
    </div>
  )
}
