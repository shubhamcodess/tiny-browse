/**
 * Every link that leaves this site opens in a new tab. Applied once per page and kept up to
 * date for content rendered later (the docs page injects README HTML), so individual links
 * never need their own target/rel.
 */
export function openExternalLinksInNewTab(root: ParentNode = document) {
  const mark = (scope: ParentNode) => {
    scope.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((a) => {
      if (a.origin === location.origin) return
      a.target = '_blank'
      a.rel = 'noopener noreferrer'
    })
  }
  mark(root)
  new MutationObserver(() => mark(root)).observe(root instanceof Document ? root.body : (root as Node), {
    childList: true,
    subtree: true,
  })
}
