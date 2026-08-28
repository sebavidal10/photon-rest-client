import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Photon Extension Test Suite', () => {
  test('Extension is present and activates properly', async () => {
    const extension = vscode.extensions.getExtension('sebavidal10.photon-rest-client');
    assert.ok(extension, 'Extension should be found in registry');

    if (!extension.isActive) {
      await extension.activate();
    }
    assert.strictEqual(extension.isActive, true, 'Extension should be active');
  });

  test('Registered commands are available', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('photon.open'), 'Command photon.open should be registered');
    assert.ok(
      commands.includes('photon.refreshSidebar'),
      'Command photon.refreshSidebar should be registered',
    );
  });

  test('Executes photon.refreshSidebar without errors', async () => {
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('photon.refreshSidebar');
    });
  });

  test('Executes photon.open without errors', async () => {
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('photon.open');
    });
  });
});
