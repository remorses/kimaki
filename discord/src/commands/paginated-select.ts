/**
 * Reusable paginated select menu helpers for Discord StringSelectMenuBuilder.
 * Discord caps select menus at 25 options. This module slices a full options
 * list into pages of PAGE_SIZE real items and appends "← Previous page" /
 * "Next page →" sentinel options so the user can navigate. Handlers detect
 * sentinel values via parsePaginationValue() and re-render the same select
 * with the new page — reusing the same customId, no new interaction handlers.
 */

const NAV_PREFIX = '__page_nav:'

/** 23 real items per page, leaving room for up to 2 nav sentinels (prev + next). */
const PAGE_SIZE = 23

export type SelectOption = {
  label: string
  value: string
  description?: string
}

/**
 * Build the options array for a single page, with prev/next nav sentinels.
 * If allOptions fits in 25 items, returns them all with no nav items.
 */
export function buildPaginatedOptions({
  allOptions,
  page,
}: {
  allOptions: SelectOption[]
  page: number
}): { options: SelectOption[]; totalPages: number } {
  // No pagination needed — everything fits in one Discord select
  if (allOptions.length <= 25) {
    return { options: allOptions, totalPages: 1 }
  }

  const totalPages = Math.ceil(allOptions.length / PAGE_SIZE)
  const safePage = Math.max(0, Math.min(page, totalPages - 1))
  const start = safePage * PAGE_SIZE
  const slice = allOptions.slice(start, start + PAGE_SIZE)

  const result: SelectOption[] = []

  if (safePage > 0) {
    result.push({
      label: `← Previous page (${safePage}/${totalPages})`,
      value: `${NAV_PREFIX}${safePage - 1}`,
      description: 'Go to previous page',
    })
  }

  result.push(...slice)

  if (safePage < totalPages - 1) {
    result.push({
      label: `Next page → (${safePage + 2}/${totalPages})`,
      value: `${NAV_PREFIX}${safePage + 1}`,
      description: 'Go to next page',
    })
  }

  return { options: result, totalPages }
}

/**
 * Check if a selected value is a pagination nav sentinel.
 * Returns the target page number if so, undefined otherwise.
 */
export function parsePaginationValue(
  value: string,
): number | undefined {
  if (!value.startsWith(NAV_PREFIX)) {
    return undefined
  }
  const pageStr = value.slice(NAV_PREFIX.length)
  const page = Number(pageStr)
  if (Number.isNaN(page)) {
    return undefined
  }
  return page
}
