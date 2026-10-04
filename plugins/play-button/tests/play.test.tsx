import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'play-button',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

test('the play button draws on every surface that has a band', async ($, on) => {
  // What sits beneath: another plugin's band (the progress bar), which must survive.
  on('ui.render', { component: 'AbovePrompt' }, async (_$, e) => ({ type: 'Text', props: {}, children: ['PROGRESS 40%'] }) as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ key: 'toggle' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /ask Claude to set up/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /PROGRESS 40%/ })).toBeDefined()
    await ui.unmount()
  }
})
