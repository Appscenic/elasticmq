  // Automatically set endpoint based on current window location
  const getDefaultEndpoint = () => {
      const protocol = window.location.protocol;
      const hostname = window.location.hostname || 'localhost';
      return `${protocol}//${hostname}:9324`;
  };

  let currentEndpoint = getDefaultEndpoint();
  var lastTimeoutStatus;

  function showStatus(message, type = 'info') {
      const statusDiv = document.getElementById('status');
      statusDiv.innerHTML = `<div class="status-message status-${type}">${message}</div>`;

      if(lastTimeoutStatus) {
        clearTimeout(lastTimeoutStatus);
      }

      lastTimeoutStatus = setTimeout(() => {
          statusDiv.innerHTML = '';
      }, 10000);
  }

  async function makeElasticMQRequest(action, queueUrl = '', params = {}) {
      try {
          const url = queueUrl || currentEndpoint;
          const queryParams = new URLSearchParams({
              Action: action,
              Version: '2012-11-05',
              ...params
          });

          const response = await fetch(`${url}?${queryParams}`, {
              method: 'POST',
              headers: {
                  'Content-Type': 'application/x-www-form-urlencoded',
              }
          });

          if (!response.ok) {
              throw new Error(`HTTP ${response.status}: ${response.statusText}`);
          }

          const text = await response.text();
          return text;
      } catch (error) {
          throw new Error(`Request failed: ${error.message}`);
      }
  }

  function parseQueueListResponse(xmlText) {
      const parser = new DOMParser();
      const doc = parser.parseFromString(xmlText, 'text/xml');
      const queueUrls = Array.from(doc.querySelectorAll('QueueUrl')).map(el => el.textContent);
      return queueUrls;
  }

  function parseAttributesResponse(xmlText) {
      const parser = new DOMParser();
      const doc = parser.parseFromString(xmlText, 'text/xml');
      const attributes = {};

      doc.querySelectorAll('Attribute').forEach(attr => {
          const name = attr.querySelector('Name')?.textContent;
          const value = attr.querySelector('Value')?.textContent;
          if (name && value) {
              attributes[name] = value;
          }
      });

      return attributes;
  }

  async function loadQueues() {
      const queuesDiv = document.getElementById('queues');
      queuesDiv.innerHTML = '<div class="empty-state"><div class="loading"></div><p>Loading queues...</p></div>';

      try {
          const listResponse = await makeElasticMQRequest('ListQueues');
          const queueUrls = parseQueueListResponse(listResponse);

          if (queueUrls.length === 0) {
              queuesDiv.innerHTML = '<div class="empty-state"><h3>No queues found</h3><p>No queues are currently available in ElasticMQ</p></div>';
              return;
          }

          const queueRows = await Promise.all(queueUrls.map(async (queueUrl) => {
              try {
                  const attributesResponse = await makeElasticMQRequest('GetQueueAttributes', queueUrl, {
                      'AttributeName.1': 'ApproximateNumberOfMessages',
                      'AttributeName.2': 'ApproximateNumberOfMessagesNotVisible'
                  });

                  const attributes = parseAttributesResponse(attributesResponse);
                  const queueName = queueUrl.split('/').pop();
                  const visibleMessages = attributes.ApproximateNumberOfMessages || '0';
                  const invisibleMessages = attributes.ApproximateNumberOfMessagesNotVisible || '0';

                  return createQueueRow(queueName, queueUrl, visibleMessages, invisibleMessages);
              } catch (error) {
                  const queueName = queueUrl.split('/').pop();
                  return createQueueRow(queueName, queueUrl, 'Error', 'Error');
              }
          }));

          queuesDiv.innerHTML = `
              <table class="queue-table">
                  <thead>
                      <tr>
                          <th>Queue Name</th>
                          <th>Available Messages</th>
                          <th>In Flight Messages</th>
                          <th>Purge</th>
                          <th>Redrive</th>
                      </tr>
                  </thead>
                  <tbody>
                      ${queueRows.join('')}
                  </tbody>
              </table>
          `;
          // showStatus(`Loaded ${queueUrls.length} queues successfully`, 'success');
      } catch (error) {
          queuesDiv.innerHTML = '<div class="empty-state"><h3>Error loading queues</h3><p>' + error.message + '</p></div>';
          showStatus('Failed to load queues: ' + error.message, 'error');
      }
  }

  function createQueueRow(queueName, queueUrl, visibleMessages, invisibleMessages) {
      const isDLQ = queueName.toLowerCase().includes('dlq') || queueName.toLowerCase().includes('dead');
      const safeQueueId = queueName.replace(/[^a-zA-Z0-9]/g, '');

      return `
          <tr class="queue-card">
            <td class="queue-name" onclick="toggleMessages('${queueUrl}', '${queueName}', '${safeQueueId}');">${queueName}</td>
            <td class="stat" onclick="toggleMessages('${queueUrl}', '${queueName}', '${safeQueueId}');">
                <span class="stat-value">${visibleMessages}</span>
            </td>
            <td class="stat" onclick="toggleMessages('${queueUrl}', '${queueName}', '${safeQueueId}');">
                <span class="stat-value">${invisibleMessages}</span>
            </td>
            <td class="queue-actions">
              <button class="btn btn-danger" onclick="purgeQueue('${queueUrl}', '${queueName}')">
                  Purge
              </button>
            </td>
            <td id="redrive-row-${safeQueueId}">
                ${isDLQ ? `<button class="btn btn-warning" onclick="showRedriveForm('${queueUrl}', '${queueName}')">
                    Redrive
                </button>` : ''}
            </td>
            <td id="redrive-${safeQueueId}" style="display: none;"></td>
          </tr>
          <tr id="messages-row-${safeQueueId}"  style="display: none;">
            <td colspan="5" id="messages-${safeQueueId}">Messages</td>
          </tr>
      `;
  }

  async function purgeQueue(queueUrl, queueName) {
      if (!confirm(`Are you sure you want to purge all messages from "${queueName}"? This action cannot be undone.`)) {
          return;
      }

      try {
          await makeElasticMQRequest('PurgeQueue', queueUrl);
          showStatus(`Queue "${queueName}" purged successfully`, 'success');
          loadQueues(); // Refresh the queue list
      } catch (error) {
          showStatus(`Failed to purge queue "${queueName}": ${error.message}`, 'error');
      }
  }

  function showRedriveForm(dlqUrl, dlqName) {
      const redriveQueueUrl = dlqUrl.replace('-DeadLetter', '');
      const redriveQueueName = dlqName.replace('-DeadLetter', '');

      var resp = confirm(`Redrive to: ${redriveQueueName} ?`);
      if(!resp) {
        return;
      }

      const safeQueueId = dlqName.replace(/[^a-zA-Z0-9]/g, '');
      const redriveRow = document.getElementById(`redrive-row-${safeQueueId}`);
      const container = document.getElementById(`redrive-${safeQueueId}`);

      // run redrive
      startRedrive(dlqUrl, redriveQueueUrl, dlqName);

  }

  async function startRedrive(dlqUrl, redriveQueueUrl, dlqName) {
      const maxMessages = 100000;

      if (!redriveQueueUrl) {
          showStatus('Please enter a target queue URL', 'error');
          return;
      }

      try {
          showStatus(`Starting redrive from "${dlqName}" to target queue...`, 'info');

          let totalRedriven = 0;
          let batchCount = 0;
          const maxBatches = 100; // Safety limit

          while (batchCount < maxBatches) {
              // Receive messages from DLQ
              const receiveResponse = await makeElasticMQRequest('ReceiveMessage', dlqUrl, {
                  MaxNumberOfMessages: Math.min(maxMessages, 10),
                  WaitTimeSeconds: 1
              });

              const parser = new DOMParser();
              const doc = parser.parseFromString(receiveResponse, 'text/xml');
              const messages = Array.from(doc.querySelectorAll('Message'));

              if (messages.length === 0) {
                  break; // No more messages
              }

              // Process each message
              for (const message of messages) {
                  const body = message.querySelector('Body')?.textContent;
                  const receiptHandle = message.querySelector('ReceiptHandle')?.textContent;

                  if (body && receiptHandle) {
                      try {
                          // Send to target queue
                          await makeElasticMQRequest('SendMessage', redriveQueueUrl, {
                              MessageBody: body
                          });

                          // Delete from DLQ
                          await makeElasticMQRequest('DeleteMessage', dlqUrl, {
                              ReceiptHandle: receiptHandle
                          });

                          totalRedriven++;
                      } catch (error) {
                          console.error('Failed to redrive message:', error);
                      }
                  }
              }

              batchCount++;

              // Update status
              showStatus(`Redriven ${totalRedriven} messages so far...`, 'info');

              // Small delay to prevent overwhelming the system
              await new Promise(resolve => setTimeout(resolve, 100));
          }

          loadQueues(); // Refresh queue stats
          showStatus(`Redrive completed! Moved ${totalRedriven} messages from "${dlqName}" to target queue.`, 'success');

      } catch (error) {
          showStatus(`Redrive failed: ${error.message}`, 'error');
      }
  }

  async function toggleMessages(queueUrl, queueName, safeQueueId) {
      const messagesRow = document.getElementById(`messages-row-${safeQueueId}`);
      if (messagesRow.style.display === 'none') {
          messagesRow.classList.add('expanded');
          messagesRow.style.display = 'table-row';
          await loadMessages(queueUrl, queueName, safeQueueId);
      } else {
          messagesRow.classList.remove('expanded');
          messagesRow.style.display = 'none';
      }
  }

  async function loadMessages(queueUrl, queueName, safeQueueId) {
      const messagesContainer = document.getElementById(`messages-${safeQueueId}`);

      messagesContainer.innerHTML = `
          <div class="messages-header">
              <h4>Messages from ${queueName}</h4>
              <button class="close-messages" onclick="closeMessages('${safeQueueId}')">Close</button>
          </div>
          <div style="text-align: center; padding: 20px;">
              <div class="loading"></div>
              <p>Loading messages...</p>
          </div>
      `;

      try {
          const messages = [];
          let batchCount = 0;
          const maxBatches = 10; // Limit to prevent overwhelming

          // Poll messages in batches
          while (batchCount < maxBatches && messages.length < 100) {
              const receiveResponse = await makeElasticMQRequest('ReceiveMessage', queueUrl, {
                  MaxNumberOfMessages: 10,
                  WaitTimeSeconds: 1,
                  AttributeName: 'All',
                  MessageAttributeName: 'All',
                  VisibilityTimeout: 10,
              });

              const parser = new DOMParser();
              const doc = parser.parseFromString(receiveResponse, 'text/xml');
              const messageBatch = Array.from(doc.querySelectorAll('Message'));

              if (messageBatch.length === 0) {
                  break; // No more messages
              }

              for (const messageElement of messageBatch) {
                  const messageId = messageElement.querySelector('MessageId')?.textContent;
                  const body = messageElement.querySelector('Body')?.textContent;
                  const receiptHandle = messageElement.querySelector('ReceiptHandle')?.textContent;
                  const md5 = messageElement.querySelector('MD5OfBody')?.textContent;

                  // Parse attributes
                  const attributes = {};
                  messageElement.querySelectorAll('Attribute').forEach(attr => {
                      const name = attr.querySelector('Name')?.textContent;
                      const value = attr.querySelector('Value')?.textContent;
                      if (name && value) {
                          attributes[name] = value;
                      }
                  });

                  // Parse message attributes
                  const messageAttributes = {};
                  messageElement.querySelectorAll('MessageAttribute').forEach(attr => {
                      const name = attr.querySelector('Name')?.textContent;
                      const value = attr.querySelector('Value')?.textContent;
                      const dataType = attr.querySelector('DataType')?.textContent;
                      if (name && value) {
                          messageAttributes[name] = { value, dataType };
                      }
                  });

                  messages.push({
                      messageId,
                      body,
                      receiptHandle,
                      md5,
                      attributes,
                      messageAttributes
                  });
              }

              batchCount++;
          }

         // show as they are fetched
         if (messages.length === 0) {
              messagesContainer.innerHTML = `
                  <div class="messages-header">
                      <h4>Messages from ${queueName}</h4>
                      <button class="close-messages" onclick="closeMessages('${safeQueueId}')">Close</button>
                  </div>
                  <div style="text-align: center; padding: 20px; color: #6c757d;">
                      <p>No messages available in this queue</p>
                  </div>
              `;
              return;
          }

        const messagesHtml = messages.map(message => createMessageCard(message, queueUrl, queueName, safeQueueId)).join('');
        messagesContainer.innerHTML = `
            <div class="messages-header">
                <h4>Messages from ${queueName} (${messages.length} messages)</h4>
                <button class="close-messages" onclick="closeMessages('${safeQueueId}')">Close</button>
            </div>
            ${messagesHtml}
        `;


      } catch (error) {
          messagesContainer.innerHTML = `
              <div class="messages-header">
                  <h4>Messages from ${queueName}</h4>
                  <button class="close-messages" onclick="closeMessages('${safeQueueId}')">Close</button>
              </div>
              <div style="text-align: center; padding: 20px; color: #dc3545;">
                  <p>Error loading messages: ${error.message}</p>
              </div>
          `;
      }
  }

  function createMessageCard(message, queueUrl, queueName, safeQueueId) {
      const messagePreview = message.body.length > 100 ?
          message.body.substring(0, 100) + '...' : message.body;

      return `
          <div class="message-card">
              <div class="message-header">
                  <span class="message-id">ID: ${message.messageId}</span>
                  <div class="message-actions">
                      <button class="btn btn-view btn-small" onclick="toggleMessageDetails('${message.messageId}')">
                          View
                      </button>
                      <button class="btn btn-delete btn-small" onclick="deleteMessage('${queueUrl}', '${message.receiptHandle}', '${message.messageId}', '${queueName}', '${safeQueueId}')">
                          Delete
                      </button>
                  </div>
              </div>
              <div class="message-preview">${messagePreview}</div>
              <div id="details-${message.messageId}" class="message-details">
                  <div class="message-body">${message.body}</div>
                  <div class="message-attributes">
                      <h5 style="margin: 0 0 10px 0; color: #495057;">Message Attributes:</h5>
                      ${Object.keys(message.attributes).length > 0 ?
                          Object.entries(message.attributes).map(([key, value]) =>
                              `<div class="attribute-item">
                                  <div class="attribute-key">${key}:</div>
                                  <div class="attribute-value">${value}</div>
                              </div>`
                          ).join('') :
                          '<div class="attribute-item"><div class="attribute-value">No attributes</div></div>'
                      }
                      ${Object.keys(message.messageAttributes).length > 0 ?
                          `<h5 style="margin: 15px 0 10px 0; color: #495057;">Custom Attributes:</h5>
                          ${Object.entries(message.messageAttributes).map(([key, attr]) =>
                              `<div class="attribute-item">
                                  <div class="attribute-key">${key} (${attr.dataType}):</div>
                                  <div class="attribute-value">${attr.value}</div>
                              </div>`
                          ).join('')}` : ''
                      }
                  </div>
              </div>
          </div>
      `;
  }

  function toggleMessageDetails(messageId) {
      const detailsDiv = document.getElementById(`details-${messageId}`);
      detailsDiv.classList.toggle('show');
  }

  async function deleteMessage(queueUrl, receiptHandle, messageId, queueName, safeQueueId) {
      if (!confirm(`Are you sure you want to delete this message?\n\nMessage ID: ${messageId}`)) {
          return;
      }

      try {
          await makeElasticMQRequest('DeleteMessage', queueUrl, {
              ReceiptHandle: receiptHandle
          });

          showStatus(`Message deleted successfully from ${queueName}`, 'success');

          // Reload messages to reflect the change
          await loadMessages(queueUrl, queueName, safeQueueId);

          // Refresh queue stats
          loadQueues();

      } catch (error) {
          showStatus(`Failed to delete message: ${error.message}`, 'error');
      }
  }

  function closeMessages(safeQueueId) {
      const messagesRow = document.getElementById(`messages-row-${safeQueueId}`);
      messagesRow.classList.remove('expanded');
      messagesRow.style.display = 'none';
  }

  // Load queues on page load
  window.addEventListener('load', () => {
    document.getElementById('mainTitle').innerHTML = `${currentEndpoint}`;
      //showStatus(`ElasticMQ Manager loaded. Using endpoint: ${currentEndpoint}`, 'info');
      // Automatically load queues on page load
      loadQueues();
  });

