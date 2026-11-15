// Capture-only entry: the shipped PWA shell over the existing fictional Host bridge.
// No production entrypoint, database, Control service or Host process is loaded.
/* global window, document, localStorage */
import React from 'react'
import { createRoot } from 'react-dom/client'
import { installMockPhosphor } from '../../../../libs/client-ui/src/dev/mockPhosphor.ts'
import '../../../../libs/client-ui/src/styles/index.css'

localStorage.setItem('mock:accountState', 'signed-in')
localStorage.setItem('mock:machinesState', 'mixed')
localStorage.setItem('mock:remoteLanes', '1')
localStorage.setItem('mock:remoteMixed', '1')
installMockPhosphor()
document.documentElement.classList.add('dark')
const { CompactApp } = await import('@phosphor/client-ui/compact')
window.captureRoot = createRoot(document.getElementById('root'))
window.captureRoot.render(React.createElement(CompactApp))
