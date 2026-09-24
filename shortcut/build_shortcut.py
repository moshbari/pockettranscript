#!/usr/bin/env python3
"""Build the "Get Transcript" iPhone Shortcut.

  python3 shortcut/build_shortcut.py

Writes shortcut/Get Transcript.unsigned.shortcut; sign it on a Mac with
  shortcuts sign --mode anyone -i <unsigned> -o public/get-transcript.shortcut

The file holds no device code — it's public. On install, iOS asks for the
code once (an import question); the phone app has a button that copies it.

Flow: Share a link or a file (or copy a link and just run it) → the server
turns it into text → pick Ask ChatGPT / Ask Claude / Just copy it → pick an
instruction (the list comes from the server, so it can change without
reinstalling) → the AI's answer is shown.
"""
import plistlib
import uuid

BASE = 'https://pocket.99dfy.com'
OBJ = '￼'  # where a variable sits inside a text field



def uid():
    return str(uuid.uuid4()).upper()


# ---- variable references ---------------------------------------------------
def out(u, name):
    return {'OutputUUID': u, 'OutputName': name, 'Type': 'ActionOutput'}


def var(name):
    return {'Type': 'Variable', 'VariableName': name}


INPUT = {'Type': 'ExtensionInput'}


def att(ref):
    """A whole parameter that is one variable."""
    return {'Value': ref, 'WFSerializationType': 'WFTextTokenAttachment'}


def tok(*parts):
    """Text with variables mixed in. Ranges count UTF-16 units."""
    s, ranges = '', {}
    for p in parts:
        if isinstance(p, str):
            s += p
        else:
            pos = len(s.encode('utf-16-le')) // 2
            ranges[f'{{{pos}, 1}}'] = p
            s += OBJ
    return {'Value': {'string': s, 'attachmentsByRange': ranges},
            'WFSerializationType': 'WFTextTokenString'}


def cond_input(ref):
    return {'Type': 'Variable', 'Variable': att(ref)}


def dict_field(items):
    return {'Value': {'WFDictionaryFieldValueItems': [
        {'WFItemType': 0, 'WFKey': tok(k), 'WFValue': v} for k, v in items
    ]}, 'WFSerializationType': 'WFDictionaryFieldValue'}


# ---- actions -----------------------------------------------------------------
actions = []


def act(ident, **params):
    if not ident.startswith(('is.', 'com.')):
        ident = 'is.workflow.actions.' + ident
    actions.append({'WFWorkflowActionIdentifier': ident, 'WFWorkflowActionParameters': params})
    return params.get('UUID')


def set_var(name, ref):
    act('setvariable', WFVariableName=name, WFInput=att(ref))


def get_key(key, from_var):
    u = uid()
    act('getvalueforkey', UUID=u, WFDictionaryKey=key, WFInput=att(var(from_var)))
    return out(u, 'Dictionary Value')


def text(*parts):
    u = uid()
    act('gettext', UUID=u, WFTextActionText=tok(*parts))
    return out(u, 'Text')


class If:
    """with If(ref, code, value): ...  — optional .otherwise() in between."""
    def __init__(self, ref, code, value=None):
        self.g = uid()
        p = dict(GroupingIdentifier=self.g, WFControlFlowMode=0, WFCondition=code,
                 WFInput=cond_input(ref))
        if value is not None:
            p['WFConditionalActionString'] = value
        self.start = p

    def __enter__(self):
        act('conditional', **self.start)
        return self

    def otherwise(self):
        act('conditional', GroupingIdentifier=self.g, WFControlFlowMode=1)

    def __exit__(self, *exc):
        act('conditional', GroupingIdentifier=self.g, WFControlFlowMode=2, UUID=uid())


def stop_with(title, *message):
    act('alert', WFAlertActionTitle=title, WFAlertActionMessage=tok(*message),
        WFAlertActionCancelButtonShown=False)
    act('exit')


IS, CONTAINS, HAS_VALUE = 4, 99, 100

# 0. The device code, typed in once when the shortcut is added.
code = text('PASTE-YOUR-CODE-HERE')
CODE_INDEX = len(actions) - 1
set_var('Code', code)
GRAB = tok(f'{BASE}/api/grab?deviceId=', var('Code'))

# 1. What was shared? A link (maybe inside a caption) or a file.
links = uid()
act('detect.link', UUID=links, WFInput=tok(INPUT))
set_var('Links', out(links, 'URLs'))

with If(var('Links'), HAS_VALUE) as branch:
    r = uid()
    act('downloadurl', UUID=r, WFURL=GRAB, WFHTTPMethod='POST', WFHTTPBodyType='JSON',
        WFJSONValues=dict_field([('url', tok(var('Links')))]), ShowWhenRun=False)
    set_var('Start', out(r, 'Contents of URL'))
    branch.otherwise()
    # A video (screen recording, camera clip) goes up as sound only — a fraction
    # of the size. Voice notes and audio files go up as they are.
    ext = uid()
    act('properties.files', UUID=ext, WFContentItemPropertyName='File Extension', WFInput=att(INPUT))
    videos = text('mov MOV mp4 MP4 m4v M4V')
    with If(videos, CONTAINS, tok(out(ext, 'File Extension'))) as vid:
        enc = uid()
        act('encodemedia', UUID=enc, WFMedia=att(INPUT), WFMediaAudioOnly=True)
        set_var('Upload', out(enc, 'Encoded Media'))
        vid.otherwise()
        set_var('Upload', INPUT)
    r = uid()
    act('downloadurl', UUID=r, WFURL=GRAB, WFHTTPMethod='POST', WFHTTPBodyType='File',
        WFRequestVariable=tok(var('Upload')), ShowWhenRun=False)
    set_var('Start', out(r, 'Contents of URL'))

err = get_key('error', 'Start')
with If(err, HAS_VALUE):
    stop_with("Couldn't start", err)
set_var('JobId', get_key('id', 'Start'))

# 2. Wait for the words. Each check holds up to 40s on the server, so 30
#    rounds covers ~20 minutes; once it's done the rest are skipped.
set_var('State', text('working'))
rg = uid()
act('repeat.count', GroupingIdentifier=rg, WFControlFlowMode=0, WFRepeatCount=30)
with If(var('State'), IS, 'working'):
    p = uid()
    act('downloadurl', UUID=p, WFHTTPMethod='GET', ShowWhenRun=False,
        WFURL=tok(f'{BASE}/api/grab/', var('JobId'), '?deviceId=', var('Code')))
    set_var('Result', out(p, 'Contents of URL'))
    set_var('State', get_key('state', 'Result'))
act('repeat.count', GroupingIdentifier=rg, WFControlFlowMode=2, UUID=uid())

with If(var('State'), IS, 'error'):
    stop_with('No transcript', get_key('error', 'Result'))
with If(var('State'), IS, 'working'):
    stop_with('Still working',
              "It's a long one. It will be waiting in PocketTranscript (pocket.99dfy.com) when it's done.")

# 3. The transcript is on the clipboard no matter what happens next.
set_var('Transcript', get_key('transcript', 'Result'))
act('setclipboard', WFInput=att(var('Transcript')))
words = get_key('words', 'Result')

dests = uid()
act('list', UUID=dests, WFItems=['Ask ChatGPT', 'Ask Claude', 'Just copy it'])
pick = uid()
act('choosefromlist', UUID=pick, WFInput=att(out(dests, 'List')),
    WFChooseFromListActionPrompt=tok('Got it: ', words, ' words. What now?'))
set_var('Dest', out(pick, 'Chosen Item'))

with If(var('Dest'), IS, 'Just copy it'):
    act('notification', WFNotificationActionTitle='Transcript copied',
        WFNotificationActionBody=tok('Paste it anywhere.'))
    act('exit')

# 4. What should the AI do with it?
choice = uid()
act('choosefromlist', UUID=choice, WFInput=att(get_key('prompts', 'Result')),
    WFChooseFromListActionPrompt='What should it do?')
set_var('Instruction', out(choice, 'Chosen Item'))
with If(var('Instruction'), CONTAINS, 'Type my own'):
    own = uid()
    act('ask', UUID=own, WFAskActionPrompt='What should it do with the transcript?', WFInputType='Text')
    set_var('Instruction', out(own, 'Provided Input'))

prompt = text(var('Instruction'), '\n\nHere is the transcript:\n\n', var('Transcript'))
# Backup: if the AI app hiccups, the full prompt is ready to paste.
act('setclipboard', WFInput=att(prompt))

with If(var('Dest'), IS, 'Ask ChatGPT') as ai:
    a = uid()
    act('com.openai.chat.AskIntent', UUID=a, ShowWhenRun=False, newChat=True,
        AppIntentDescriptor={'TeamIdentifier': '2DC432GLL2', 'BundleIdentifier': 'com.openai.chat',
                             'Name': 'ChatGPT', 'AppIntentIdentifier': 'AskIntent'},
        prompt=tok(prompt))
    act('showresult', Text=tok(out(a, 'Response')))
    ai.otherwise()
    c = uid()
    act('com.anthropic.claude.ClaudeAppIntentsExtension', UUID=c, ShowWhenRun=False,
        AppIntentDescriptor={'TeamIdentifier': 'Q6L2SF6YDW', 'BundleIdentifier': 'com.anthropic.claude',
                             'Name': 'Claude', 'AppIntentIdentifier': 'ClaudeAppIntentsExtension'},
        message=tok(prompt))
    act('showresult', Text=tok(out(c, 'Response')))

shortcut = {
    'WFWorkflowActions': actions,
    'WFWorkflowClientVersion': '2700.0.4',
    'WFWorkflowMinimumClientVersion': 900,
    'WFWorkflowMinimumClientVersionString': '900',
    'WFWorkflowName': 'Get Transcript',
    'WFWorkflowIcon': {'WFWorkflowIconGlyphNumber': 61566, 'WFWorkflowIconStartColor': 2071128575},
    'WFWorkflowHasOutputFallback': False,
    'WFWorkflowImportQuestions': [{
        'ActionIndex': CODE_INDEX,
        'Category': 'Parameter',
        'ParameterKey': 'WFTextActionText',
        'DefaultValue': '',
        'Text': 'Paste your PocketTranscript code (open pocket.99dfy.com, tap "Share button", it copies it for you).',
    }],
    'WFWorkflowOutputContentItemClasses': [],
    'WFWorkflowTypes': ['ActionExtension'],   # shows up in the Share menu
    'WFWorkflowHasShortcutInputVariables': True,
    'WFWorkflowInputContentItemClasses': [
        'WFURLContentItem', 'WFStringContentItem', 'WFSafariWebPageContentItem',
        'WFAVAssetContentItem', 'WFGenericFileContentItem',
    ],
    # Run it from the home screen with a link copied, and it uses the clipboard.
    'WFWorkflowNoInputBehavior': {'Name': 'WFWorkflowNoInputBehaviorGetClipboard', 'Parameters': {}},
}

path = 'shortcut/Get Transcript.unsigned.shortcut'
with open(path, 'wb') as f:
    plistlib.dump(shortcut, f, fmt=plistlib.FMT_XML)
print(f'{path}: {len(actions)} actions')
