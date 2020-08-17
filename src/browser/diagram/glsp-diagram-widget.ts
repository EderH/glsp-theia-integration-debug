/********************************************************************************
 * Copyright (c) 2019 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License v. 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * This Source Code may also be made available under the following Secondary
 * Licenses when the conditions for such availability set forth in the Eclipse
 * Public License v. 2.0 are satisfied: GNU General Public License, version 2
 * with the GNU Classpath Exception which is available at
 * https://www.gnu.org/software/classpath/license.html.
 *
 * SPDX-License-Identifier: EPL-2.0 OR GPL-2.0 WITH Classpath-exception-2.0
 ********************************************************************************/
import {
    AddBreakpointAction,
    DiagramServer,
    EditorContextService,
    EnableToolPaletteAction,
    GLSP_TYPES,
    IActionDispatcher,
    ICopyPasteHandler,
    ModelSource,
    RemoveBreakpointAction,
    RequestModelAction,
    RequestTypeHintsAction,
    SaveModelAction,
    SetEditModeAction,
    SModelElement,
    TYPES
} from "@eclipse-glsp/client";
import { GLSPBreakpoint } from "@glsp/theia-debug-diagram/lib/browser/breakpoint/glsp-breakpoint-marker";
import { Message } from "@phosphor/messaging/lib";
import { Saveable, SaveableSource } from "@theia/core/lib/browser";
import { Disposable, DisposableCollection, Emitter, Event, MaybePromise } from "@theia/core/lib/common";
import { EditorPreferences } from "@theia/editor/lib/browser";
import { Container } from "inversify";
import { DiagramWidget, DiagramWidgetOptions, TheiaSprottyConnector } from "sprotty-theia";

import { GLSPWidgetOpenerOptions, GLSPWidgetOptions } from "./glsp-diagram-manager";
import { DirtyStateNotifier, GLSPTheiaDiagramServer, NotifyingModelSource } from "./glsp-theia-diagram-server";
import { GLSPTheiaSprottyConnector } from "./glsp-theia-sprotty-connector";


export class GLSPDiagramWidget extends DiagramWidget implements SaveableSource {

    protected copyPasteHandler?: ICopyPasteHandler;
    saveable = new SaveableGLSPModelSource(this.actionDispatcher, this.diContainer.get<ModelSource>(TYPES.ModelSource));
    breakpointService = new GLSPBreakpointService(this.actionDispatcher, this.diContainer.get<ModelSource>(TYPES.ModelSource), this, this.connector as GLSPTheiaSprottyConnector);

    options: DiagramWidgetOptions & GLSPWidgetOptions;
    constructor(options: DiagramWidgetOptions & GLSPWidgetOpenerOptions, readonly widgetId: string, readonly diContainer: Container,
        readonly editorPreferences: EditorPreferences, readonly connector?: TheiaSprottyConnector) {
        super(options, widgetId, diContainer, connector);
        this.updateSaveable();
        this.title.caption = this.uri.path.toString();
        const prefUpdater = editorPreferences.onPreferenceChanged(() => this.updateSaveable());
        this.toDispose.push(prefUpdater);
        this.toDispose.push(this.saveable);
    }

    protected updateSaveable() {
        this.saveable.autoSave = this.editorPreferences['editor.autoSave'];
        this.saveable.autoSaveDelay = this.editorPreferences['editor.autoSaveDelay'];
    }

    protected initializeSprotty() {
        const modelSource = this.diContainer.get<ModelSource>(TYPES.ModelSource);
        if (modelSource instanceof DiagramServer)
            modelSource.clientId = this.id;
        if (modelSource instanceof GLSPTheiaDiagramServer && this.connector)
            this.connector.connect(modelSource);

        this.disposed.connect(() => {
            if (modelSource instanceof GLSPTheiaDiagramServer && this.connector)
                this.connector.disconnect(modelSource);
        });

        this.actionDispatcher.dispatch(new RequestModelAction({
            sourceUri: this.uri.path.toString(),
            needsClientLayout: `${this.viewerOptions.needsClientLayout}`,
            ... this.options
        }));

        this.actionDispatcher.dispatch(new RequestTypeHintsAction(this.options.diagramType));
        this.actionDispatcher.dispatch(new EnableToolPaletteAction());
        this.actionDispatcher.dispatch(new SetEditModeAction(this.options.editMode));
    }

    protected onAfterAttach(msg: Message): void {
        super.onAfterAttach(msg);
        this.node.dataset['uri'] = this.uri.toString();
        if (this.diContainer.isBound(GLSP_TYPES.ICopyPasteHandler)) {
            this.copyPasteHandler = this.diContainer.get<ICopyPasteHandler>(GLSP_TYPES.ICopyPasteHandler);
            this.addClipboardListener(this.node, 'copy', e => this.handleCopy(e));
            this.addClipboardListener(this.node, 'paste', e => this.handlePaste(e));
            this.addClipboardListener(this.node, 'cut', e => this.handleCut(e));
        }
    }

    get diagramType(): string {
        return this.options.diagramType;
    }

    get editorContext(): EditorContextService {
        return this.diContainer.get(EditorContextService);
    }

    handleCopy(e: ClipboardEvent) {
        if (this.copyPasteHandler) {
            this.copyPasteHandler.handleCopy(e);
        }
    }

    handleCut(e: ClipboardEvent) {
        if (this.copyPasteHandler) {
            this.copyPasteHandler.handleCut(e);
        }
    }

    handlePaste(e: ClipboardEvent) {
        if (this.copyPasteHandler) {
            this.copyPasteHandler.handlePaste(e);
        }
    }
}

export class SaveableGLSPModelSource implements Saveable, Disposable {
    isAutoSave: "on" | "off" = "on";
    autoSaveDelay: number = 500;

    private autoSaveJobs = new DisposableCollection();
    private isDirty: boolean = false;
    readonly dirtyChangedEmitter: Emitter<void> = new Emitter<void>();

    constructor(readonly actionDispatcher: IActionDispatcher, readonly modelSource: ModelSource) {
        if (DirtyStateNotifier.is(this.modelSource)) {
            this.modelSource.onDirtyStateChange((dirtyState) => this.dirty = dirtyState.isDirty);
        }
    }

    get onDirtyChanged(): Event<void> {
        return this.dirtyChangedEmitter.event;
    }

    save(): MaybePromise<void> {
        return this.actionDispatcher.dispatch(new SaveModelAction());
    }

    get dirty(): boolean {
        return this.isDirty;
    }

    set dirty(newDirty: boolean) {
        const oldValue = this.isDirty;
        if (oldValue !== newDirty) {
            this.isDirty = newDirty;
            this.dirtyChangedEmitter.fire(undefined);
        }
        this.scheduleAutoSave();
    }

    set autoSave(isAutoSave: "on" | "off") {
        this.isAutoSave = isAutoSave;
        if (this.shouldAutoSave) {
            this.scheduleAutoSave();
        } else {
            this.autoSaveJobs.dispose();
        }
    }

    get autoSave(): "on" | "off" {
        return this.isAutoSave;
    }

    protected scheduleAutoSave() {
        if (this.shouldAutoSave) {
            this.autoSaveJobs.dispose();
            const autoSaveJob = window.setTimeout(() => this.doAutoSave(), this.autoSaveDelay);
            const disposableAutoSaveJob = Disposable.create(() => window.clearTimeout(autoSaveJob));
            this.autoSaveJobs.push(disposableAutoSaveJob);
        }
    }

    protected doAutoSave() {
        if (this.shouldAutoSave) {
            this.save();
        }
    }

    protected get shouldAutoSave(): boolean {
        return this.dirty && this.autoSave === 'on';
    }

    dispose(): void {
        this.autoSaveJobs.dispose();
        this.dirtyChangedEmitter.dispose();
    }
}

export class GLSPBreakpointService {

    private glspBreakpoints: GLSPBreakpoint[] = [];
    readonly breakpointsChangedEmitter: Emitter<void> = new Emitter<void>();

    constructor(
        readonly actionDispather: IActionDispatcher,
        readonly modelSource: ModelSource,
        readonly diagramWidget: GLSPDiagramWidget,
        readonly connector?: GLSPTheiaSprottyConnector
    ) {

        if (NotifyingModelSource.is(this.modelSource)) {
            const notifyingModelSource = this.modelSource as NotifyingModelSource;
            notifyingModelSource.onHandledAction((action) => {
                if (action.kind === AddBreakpointAction.KIND) {
                    this.addBreakpoint(action.selectedElements);
                } else if (action.kind === RemoveBreakpointAction.KIND) {
                    this.removeBreakpoint(action.selectedElements);
                }

            });
        }
        this.onBreakpointsChanged(() => {
            if (connector) {
                connector.sendBreakpoints(this.diagramWidget.uri.path.toString(), this.getGLSPBreakpoints());
            }
        });
    }

    get onBreakpointsChanged(): Event<void> {
        return this.breakpointsChangedEmitter.event;
    }

    protected addBreakpoint(selectedElements: SModelElement[]) {
        for (const selectedElement of selectedElements) {
            const breakpoint = this.glspBreakpoints.find(bp => bp.element.id === selectedElement.id);
            if (!breakpoint) {
                const path = this.diagramWidget.uri.path.toString()
                if (path) {
                    this.glspBreakpoints.push(GLSPBreakpoint.create(path, selectedElement));
                }
            }
        }
        this.breakpointsChangedEmitter.fire();
    }

    protected removeBreakpoint(selectedElements: SModelElement[]) {
        for (const selectedElement of selectedElements) {
            this.glspBreakpoints = this.glspBreakpoints.filter(bp => bp.element.id !== selectedElement.id);
        }
        this.breakpointsChangedEmitter.fire();
    }

    protected getGLSPBreakpoints(): GLSPBreakpoint[] {
        return this.glspBreakpoints;
    }
}
