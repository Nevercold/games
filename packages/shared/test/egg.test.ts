import { describe, expect, it } from 'vitest'
import { convertEgg, convertEggPlaceholders, parseLaravelRules } from '../src/egg'
import { renderPlaceholders, validateVariables } from '../src/variables'

// Trimmed-down version of the official Paper egg (PTDL_v2 shape).
const paperEgg = {
  meta: { version: 'PTDL_v2' },
  name: 'Paper',
  author: 'parker@pterodactyl.io',
  description: 'High performance Spigot fork',
  docker_images: {
    'Java 21': 'ghcr.io/pterodactyl/yolks:java_21',
    'Java 17': 'ghcr.io/pterodactyl/yolks:java_17',
  },
  startup: 'java -Xms128M -Xmx{{SERVER_MEMORY}}M -jar {{SERVER_JARFILE}}',
  config: {
    files: JSON.stringify({
      'server.properties': {
        parser: 'properties',
        find: { 'server-ip': '0.0.0.0', 'server-port': '{{server.build.default.port}}', 'query.port': '{{server.build.default.port}}' },
      },
    }),
    startup: JSON.stringify({ done: ')! For help, type ' }),
    logs: '{}',
    stop: 'stop',
  },
  scripts: {
    installation: {
      script: '#!/bin/bash\r\necho install\r\n',
      container: 'ghcr.io/pterodactyl/installers:alpine',
      entrypoint: 'ash',
    },
  },
  variables: [
    {
      name: 'Minecraft Version',
      env_variable: 'MINECRAFT_VERSION',
      default_value: 'latest',
      user_viewable: true,
      user_editable: true,
      rules: 'nullable|string|max:20',
    },
    {
      name: 'Server Jar File',
      env_variable: 'SERVER_JARFILE',
      default_value: 'server.jar',
      user_viewable: true,
      user_editable: true,
      rules: 'required|regex:/^([\\w\\d._-]+)(\\.jar)$/',
    },
    {
      name: 'Build Number',
      env_variable: 'BUILD_NUMBER',
      default_value: 'latest',
      user_viewable: true,
      user_editable: true,
      rules: 'required|string|max:20',
    },
    {
      name: 'Online Mode',
      env_variable: 'ONLINE_MODE',
      default_value: '1',
      user_viewable: true,
      user_editable: false,
      rules: 'required|boolean',
    },
    {
      name: 'Difficulty',
      env_variable: 'DIFFICULTY',
      default_value: 'normal',
      user_viewable: true,
      user_editable: true,
      rules: 'required|string|in:peaceful,easy,normal,hard',
    },
    {
      name: 'Max Players',
      env_variable: 'MAX_PLAYERS',
      default_value: '20',
      user_viewable: true,
      user_editable: true,
      rules: 'required|integer|between:1,500',
    },
  ],
}

describe('convertEgg', () => {
  const { template, warnings } = convertEgg(paperEgg)

  it('maps metadata, images and startup', () => {
    expect(template.id).toBe('paper')
    expect(template.images).toEqual(paperEgg.docker_images)
    expect(template.startup?.command).toBe(paperEgg.startup)
    expect(template.startup?.done).toEqual([')! For help, type '])
    expect(template.startup?.stop).toBe('stop')
    expect(template.source).toEqual({ kind: 'egg', ref: 'PTDL_v2' })
  })

  it('converts install script with LF line endings', () => {
    expect(template.hooks.install).toEqual({
      image: 'ghcr.io/pterodactyl/installers:alpine',
      entrypoint: 'ash',
      script: '#!/bin/bash\necho install\n',
    })
  })

  it('types variables from Laravel rules', () => {
    const byEnv = Object.fromEntries(template.variables.map((v) => [v.env, v]))
    expect(byEnv.MINECRAFT_VERSION).toMatchObject({ type: 'string', max: 20, required: false })
    expect(byEnv.SERVER_JARFILE).toMatchObject({ type: 'string', regex: '^([\\w\\d._-]+)(\\.jar)$', required: true })
    expect(byEnv.ONLINE_MODE).toMatchObject({ type: 'bool', default: true, user_editable: false })
    expect(byEnv.DIFFICULTY).toMatchObject({ type: 'enum', options: ['peaceful', 'easy', 'normal', 'hard'], default: 'normal' })
    expect(byEnv.MAX_PLAYERS).toMatchObject({ type: 'int', default: 20, min: 1, max: 500 })
  })

  it('converts config file placeholders', () => {
    expect(template.config_files).toEqual([
      {
        path: 'server.properties',
        parser: 'properties',
        set: { 'server-ip': '0.0.0.0', 'server-port': '{{SERVER_PORT}}', 'query.port': '{{SERVER_PORT}}' },
      },
    ])
    expect(warnings).toEqual([])
  })

  it('maps ^C to SIGINT', () => {
    const { template: t } = convertEgg({ ...paperEgg, config: { ...paperEgg.config, stop: '^C' } })
    expect(t.startup?.stop).toEqual({ signal: 'SIGINT' })
  })

  it('rejects non-objects', () => {
    expect(() => convertEgg('nope')).toThrow()
    expect(() => convertEgg({})).toThrow()
  })
})

describe('parseLaravelRules', () => {
  it('keeps pipes inside regex', () => {
    expect(parseLaravelRules('required|regex:/^(a|b)$/').regex).toBe('^(a|b)$')
  })
  it('accepts array rules', () => {
    expect(parseLaravelRules(['required', 'numeric', 'max:10'])).toMatchObject({ required: true, type: 'int', max: 10 })
  })
  it('reports unknown rules', () => {
    expect(parseLaravelRules('required|url').unknown).toEqual(['url'])
  })
})

describe('placeholders', () => {
  it('converts egg expressions', () => {
    expect(convertEggPlaceholders('{{server.build.env.FOO}}:{{server.build.memory}}:{{env.BAR}}')).toBe('{{FOO}}:{{SERVER_MEMORY}}:{{BAR}}')
  })
  it('renders env values', () => {
    expect(renderPlaceholders('port={{SERVER_PORT}} x={{MISSING}}', { SERVER_PORT: '25565' })).toBe('port=25565 x=')
  })
})

describe('validateVariables', () => {
  const { template } = convertEgg(paperEgg)

  it('applies defaults and validates', () => {
    const { values, errors } = validateVariables(template.variables, { MAX_PLAYERS: '1000', SERVER_JARFILE: 'x.zip' })
    expect(values.DIFFICULTY).toBe('normal')
    expect(values.ONLINE_MODE).toBe('1')
    expect(errors.MAX_PLAYERS).toBe('maximum 500')
    expect(errors.SERVER_JARFILE).toBe('invalid format')
  })

  it('ignores non-editable variables for regular users', () => {
    const { values } = validateVariables(template.variables, { ONLINE_MODE: '0' }, {
      previous: { ONLINE_MODE: '1' },
      onlyUserEditable: true,
    })
    expect(values.ONLINE_MODE).toBe('1')
  })
})
