// XML/HTML tag content extractor.
// Parses XML-like tags from strings (e.g., channel topics) to extract
// Kimaki configuration like directory paths and app IDs.

import { DomHandler, Parser, ElementType } from 'htmlparser2'
import type { ChildNode, Element, Text } from 'domhandler'
import { createLogger } from './logger.js'

const xmlLogger = createLogger('XML')

export function extractTagsArrays<T extends string>({
  xml,
  tags,
}: {
  xml: string
  tags: T[]
}): Record<T, string[]> & { others: string[] } {
  const result: Record<string, string[]> = {
    others: [],
  }

  // Initialize arrays for each tag
  tags.forEach((tag) => {
    result[tag] = []
  })

  try {
    const handler = new DomHandler(
      (error, dom) => {
        if (error) {
          xmlLogger.error('Error parsing XML:', error)
        } else {
          const findTags = (nodes: ChildNode[], path: string[] = []) => {
            nodes.forEach((node) => {
              if (node.type === ElementType.Tag) {
                const element = node as Element
                const currentPath = [...path, element.name]
                const pathString = currentPath.join('.')

                // Extract content using original string positions
                const extractContent = (): string => {
                  // Use element's own indices but exclude the tags
                  if (element.startIndex !== null && element.endIndex !== null) {
                    // Extract the full element including tags
                    const fullElement = xml.substring(element.startIndex, element.endIndex + 1)
                    // Find where content starts (after opening tag)
                    const contentStart = fullElement.indexOf('>') + 1
                    // Find where content ends (before this element's closing tag)
                    const closingTag = `</${element.name}>`
                    const contentEnd = fullElement.lastIndexOf(closingTag)

                    if (contentStart > 0 && contentEnd > contentStart) {
                      return fullElement.substring(contentStart, contentEnd)
                    }

                    return ''
                  }
                  return ''
                }

                // Check both single tag names and nested paths
                if (tags.includes(element.name as T)) {
                  const content = extractContent()
                  result[element.name as T]?.push(content)
                }

                // Check for nested path matches
                if (tags.includes(pathString as T)) {
                  const content = extractContent()
                  result[pathString as T]?.push(content)
                }

                if (element.children) {
                  findTags(element.children, currentPath)
                }
              } else if (node.type === ElementType.Text && node.parent?.type === ElementType.Root) {
                const textNode = node as Text
                if (textNode.data.trim()) {
                  // console.log('node.parent',node.parent)
                  result.others?.push(textNode.data.trim())
                }
              }
            })
          }

          findTags(dom)
        }
      },
      {
        withStartIndices: true,
        withEndIndices: true,
        xmlMode: true,
      },
    )

    const parser = new Parser(handler, {
      xmlMode: true,
      decodeEntities: false,
    })
    parser.write(xml)
    parser.end()
  } catch (error) {
    xmlLogger.error('Unexpected error in extractTags:', error)
  }

  return result as Record<T, string[]> & { others: string[] }
}

export function extractNonXmlContent(xml: string): string {
  const result = extractTagsArrays({ xml, tags: [] })
  return result.others.join('\n')
}
