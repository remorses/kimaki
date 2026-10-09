/**
 * Full-bleed hero with serif title, install CTA, and Discord playground.
 * Centered heading and CTA above, full-width playground below.
 */
'use client'

import { Zap } from 'lucide-react'

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
import { HeroDither } from './hero-dither.tsx'

const GITHUB_URL = 'https://github.com/remorses/kimaki'
const CREATE_MACHINE_URL = '/dashboard/create'

export function HeroSection() {
  return (
    <div className='relative isolate mt-10 mb-16 lg:mt-14 lg:mb-20 w-full'>
      <StradaBrowser />
      <HeroDither />

      <div className='relative z-[2] flex w-full flex-col items-center gap-12 lg:gap-14'>
        <div className='flex w-full max-w-[640px] flex-col items-center text-center'>
          <h1
            className='italic leading-[1.08] text-[40px] sm:text-[56px] md:text-[68px] font-medium text-foreground text-balance'
            style={{
              fontFamily: "'Playfair Display', Georgia, 'Times New Roman', serif",
            }}
          >
            AI coding agents from Discord.
          </h1>
          <p className='mt-5 max-w-[520px] text-[16px] sm:text-[18px] leading-relaxed text-foreground/60 text-balance'>
            Each channel is a project, each thread is a session. Message your
            agents from anywhere and come back to finished work.
          </p>
          <InstallCommand />
          <div className='flex items-center justify-center gap-3 mt-5'>
            <a
              href={CREATE_MACHINE_URL}
              className='flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors'
            >
              <Zap size={15} />
              Create Kimaki Cloud Machine
            </a>
            <a
              target='_blank'
              rel='noopener noreferrer'
              className='flex items-center gap-2 px-4 py-2 rounded-lg border border-foreground/20 text-foreground/80 text-sm font-medium hover:bg-foreground/5 transition-colors'
              href={GITHUB_URL}
            >
              <GithubIcon size={15} />
              GitHub
            </a>
          </div>
        </div>
        <div className='w-full min-w-0'>
          <DiscordPlayground />
        </div>
      </div>
    </div>
  )
}
