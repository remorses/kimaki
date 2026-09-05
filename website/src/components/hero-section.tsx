/**
 * Full-bleed hero with serif title, install CTA, and Discord playground.
 * Heading on the left, playground on the right. Background shader is off.
 */
'use client'

import { MessageSquare } from 'lucide-react'

function GithubIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox='0 0 24 24' fill='currentColor'>
      <path d='M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z' />
    </svg>
  )
}
import { InstallCommand } from './install-command.tsx'
import { StradaBrowser } from '../strada-browser.tsx'
import { DiscordPlayground } from './discord-playground.tsx'
// import { VideoBackgroundShader } from '@holocron.so/vite/mdx'

const GITHUB_URL = 'https://github.com/remorses/kimaki'
const DISCORD_URL = 'https://discord.gg/qz3hapKcMM'

export function HeroSection() {
  return (
    <div className='relative mt-10 mb-16 lg:mt-14 lg:mb-20 w-full'>
      <StradaBrowser />
      {/* <VideoBackgroundShader
        src='/assets/hero-bg.mp4'
        className='absolute inset-0 w-full h-full'
        canvasClassName=''
        dotColor='#8da4ffb3'
        dotSize={6}
        minDotSize={1}
        dotMargin={1}
        animSpeed={3}
        gamma={0.5}
        enableMask={false}
        fluidStrength={0.2}
        fluidCurl={80}
      /> */}

      <div className='relative z-[2] flex w-full flex-col items-stretch gap-8 lg:flex-row lg:items-center lg:gap-10'>
        <div className='flex w-full max-w-[280px] shrink-0 flex-col items-start text-left'>
          <h1 className='flex flex-col items-start leading-none text-left'>
            <span
              className='italic text-[36px] sm:text-[48px] md:text-[56px] font-medium text-foreground'
              style={{
                fontFamily:
                  "'Playfair Display', Georgia, 'Times New Roman', serif",
              }}
            >
              Kimaki
            </span>
            <span
              className='italic text-[36px] sm:text-[48px] md:text-[56px] font-medium text-foreground -mt-1 sm:-mt-2'
              style={{
                fontFamily:
                  "'Playfair Display', Georgia, 'Times New Roman', serif",
              }}
            >
              your AI dev team,
            </span>
            <span
              className='italic text-[36px] sm:text-[48px] md:text-[56px] font-medium text-foreground -mt-1 sm:-mt-2'
              style={{
                fontFamily:
                  "'Playfair Display', Georgia, 'Times New Roman', serif",
              }}
            >
              on Discord.
            </span>
          </h1>
          <InstallCommand />
          <div className='flex items-center gap-5 mt-4'>
            <a
              target='_blank'
              rel='noopener noreferrer'
              className='flex items-center gap-1.5 text-[13px] font-mono text-foreground/70 hover:text-foreground transition-colors'
              href={GITHUB_URL}
            >
              <GithubIcon size={14} />
              GitHub
            </a>
            <a
              target='_blank'
              rel='noopener noreferrer'
              className='flex items-center gap-1.5 text-[13px] font-mono text-foreground/70 hover:text-foreground transition-colors'
              href={DISCORD_URL}
            >
              <MessageSquare size={14} />
              Discord
            </a>
          </div>
        </div>
        <div className='min-w-0 flex-1'>
          <DiscordPlayground />
        </div>
      </div>
    </div>
  )
}
